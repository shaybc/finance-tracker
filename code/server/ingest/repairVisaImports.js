// Plans and applies verified repairs to historical Visa text imports.
import fs from "node:fs/promises";
import path from "node:path";
import XLSX from "xlsx";
import { sha256Hex } from "../utils/hash.js";
import { extractCardLast4FromFileName } from "../utils/source.js";
import { normalizeRecord } from "./normalize.js";
import { readVisaTextRows, parseVisaPortal } from "./parsers/creditCardVisaPortalParser.js";
import { applyRulesToTransaction } from "./categorize.js";
import { reindexTransactionsChronologically } from "../db/transactions.js";
import { recalculateTransactionBalances } from "../db/balances.js";

const transactionColumns = ["txn_date", "posting_date", "original_txn_date", "amount_signed", "original_amount_signed", "currency", "direction", "dedupe_key", "raw_json"];
const duplicateColumns = ["txn_date", "posting_date", "amount_signed", "currency", "direction", "raw_json"];
const parseRaw = (value) => { try { return JSON.parse(value || "{}"); } catch { return {}; } };
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const header = (value) => clean(value).replace(/[\s"'״]/g, "");
const cents = (value) => Math.round(Number(value) * 100);

/** Reject file operations outside the configured processed directory. */
export function processedPath(root, candidate) {
  const absolute = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path outside processed directory: ${candidate}`);
  return absolute;
}

async function listFiles(root, directory = root) {
  const files = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const filePath = processedPath(root, path.join(directory, item.name));
    if (item.isSymbolicLink()) throw new Error(`Symbolic links are not supported during repair: ${filePath}`);
    if (item.isDirectory()) files.push(...await listFiles(root, filePath));
    else if (item.isFile()) files.push(filePath);
  }
  return files;
}

/** Fingerprint repair-relevant state so stale plans cannot overwrite newer edits. */
export function repairRevision(db) {
  return sha256Hex(JSON.stringify(["transactions", "import_duplicates", "imports", "rules", "categories", "tags", "settings"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())));
}

function equivalentCell(a, b) {
  if (clean(a) === clean(b)) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.00001;
  return false;
}

function matchesSource(stored, entry) {
  if (clean(stored.account_ref) !== clean(entry.norm.accountRef) || clean(stored.merchant) !== clean(entry.norm.merchant)) return false;
  const raw = parseRaw(stored.raw_json);
  const sourceValues = Object.entries(entry.norm.raw).filter(([key]) => key !== "_visa");
  const saved = new Map(Object.entries(raw).filter(([key]) => key !== "_visa").map(([key, value]) => [header(key), value]));
  let evidence = 0;
  for (let column = 0; column < sourceValues.length; column++) {
    const [key, value] = sourceValues[column];
    if (!saved.has(header(key))) { if (clean(value)) return false; else continue; }
    const old = saved.get(header(key));
    if (!equivalentCell(old, value) && !equivalentCell(old, entry.legacy[column] ?? "")) return false;
    if (clean(value)) evidence++;
  }
  return evidence >= 3;
}

function correctedFields(norm) {
  return {
    txn_date: norm.txnDate, posting_date: norm.postingDate, original_txn_date: norm.originalTxnDate,
    amount_signed: norm.amountSigned, original_amount_signed: norm.originalAmountSigned,
    currency: norm.currency, direction: norm.direction, dedupe_key: norm.dedupeKey,
    raw_json: JSON.stringify(norm.raw),
  };
}

function recoveredTransaction(entry) {
  const { norm, stored } = entry;
  return {
    source: norm.source, source_file: norm.sourceFile, source_row: stored.source_row,
    intra_day_index: stored.source_row, account_ref: norm.accountRef,
    merchant: stored.merchant, description: stored.description, category_raw: stored.category_raw,
    ...correctedFields(norm), real_balance_after: null, affected_balance_after: null,
    balance_amount: null, balance_is_calculated: 0, category_id: null, notes: null, tags: null,
    created_at: stored.created_at,
  };
}

function addIssue(plan, importId, reason, details = {}) {
  plan.unresolved.push({ importId, reason, ...details });
}

/** Inspect source files and SQLite without modifying either; return a reviewable repair plan. */
export async function planVisaImportRepair(db, { processedDir }) {
  const root = await fs.realpath(processedDir);
  const imports = db.prepare("SELECT * FROM imports ORDER BY id").all();
  const transactions = db.prepare("SELECT * FROM transactions ORDER BY source_row, id").all();
  const duplicates = db.prepare("SELECT * FROM import_duplicates ORDER BY source_row, id").all();
  const plan = { version: 1, processedDir: root, revision: repairRevision(db), statements: [], actions: [], files: [], unresolved: [], unsupported: [], summary: {} };
  const byHash = new Map();
  const byName = new Map();
  for (const filePath of await listFiles(root)) {
    const buffer = await fs.readFile(filePath);
    const hash = sha256Hex(buffer);
    const file = { filePath, hash, buffer };
    byHash.set(hash, [...(byHash.get(hash) || []), file]);
    byName.set(path.basename(filePath), [...(byName.get(path.basename(filePath)) || []), file]);
  }
  const entries = [];
  const mappedTransactions = new Set();
  for (const item of imports) {
    let candidates = byHash.get(item.file_sha256) || [];
    if (!candidates.length) {
      addIssue(plan, item.id, byName.has(item.file_name) ? "source_hash_changed" : "source_file_missing", { fileName: item.file_name });
      continue;
    }
    const preferred = candidates.find((file) => path.resolve(file.filePath) === path.resolve(item.processed_path || ""));
    if (preferred) candidates = [preferred];
    if (candidates.length > 1) {
      const named = candidates.filter((file) => path.basename(file.filePath) === item.file_name);
      if (named.length === 1) candidates = named;
    }
    const file = candidates[0];
    const textRows = readVisaTextRows(file.buffer);
    if (!textRows) { plan.unsupported.push({ importId: item.id, fileName: item.file_name, reason: "not_visa_text" }); continue; }
    if (candidates.length !== 1) { addIssue(plan, item.id, "ambiguous_source_paths", { paths: candidates.map((entry) => entry.filePath) }); continue; }
    if (imports.some((other) => other.id !== item.id && other.file_name === item.file_name && other.source === item.source)) {
      addIssue(plan, item.id, "ambiguous_transaction_import_owner", { fileName: item.file_name }); continue;
    }
    const audit = {};
    let parsed;
    try { parsed = parseVisaPortal({ wb: null, textRows, fileCardLast4: extractCardLast4FromFileName(item.file_name), fileName: item.file_name, audit, quiet: true }); }
    catch (error) { addIssue(plan, item.id, "parse_error", { message: error.message }); continue; }
    if (!parsed.statementMonth) { addIssue(plan, item.id, "missing_statement_month"); continue; }
    for (const issue of audit.issues || []) addIssue(plan, item.id, issue.reason, issue);
    const chargeTotal = (audit.rows || []).filter((entry) => !entry.skipReason).reduce((sum, entry) => sum + cents(entry.record.amountCharge), 0);
    if (audit.totals.length !== 1 || cents(audit.totals[0].amount) !== chargeTotal) {
      addIssue(plan, item.id, "statement_total_mismatch", { sourceTotals: audit.totals, parsedTotal: chargeTotal / 100 });
    }
    const statement = { importId: item.id, fileName: item.file_name, statementMonth: parsed.statementMonth, sourceRows: audit.rows.length, chargeRows: parsed.length, chargeTotal: chargeTotal / 100, matchedTransactions: 0, matchedDuplicates: 0 };
    plan.statements.push(statement);
    const destination = processedPath(root, path.join(root, item.source, parsed.statementMonth, item.file_name));
    try { if (sha256Hex(await fs.readFile(destination)) !== item.file_sha256) addIssue(plan, item.id, "destination_collision", { destination }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    plan.files.push({ importId: item.id, sha256: item.file_sha256, oldPath: file.filePath, newPath: destination, before: item });
    // Reproduce legacy cell coercion only for matching; never use it for repaired values.
    const legacyBook = XLSX.read(file.buffer, { type: "buffer" });
    const legacyRows = XLSX.utils.sheet_to_json(legacyBook.Sheets[legacyBook.SheetNames[0]], { header: 1, raw: true, defval: "", blankrows: true });
    const sourceEntries = audit.rows.map(({ record, skipReason }, index) => ({
      importId: item.id, skipReason, norm: normalizeRecord(record, { sourceFile: item.file_name, sourceRow: index + 1 }),
      legacy: legacyRows[record.raw._visa.sourceRow - 1] || [], stored: null, table: null,
    }));
    const storedRows = [
      ...transactions.filter((row) => row.source_file === item.file_name && row.source === item.source).map((row) => ({ row, table: "transactions" })),
      ...duplicates.filter((row) => row.import_id === item.id).map((row) => ({ row, table: "import_duplicates" })),
    ].sort((a, b) => (a.row.source_row - b.row.source_row) || a.row.id - b.row.id);
    for (const { row, table } of storedRows) {
      const matches = sourceEntries.filter((entry) => !entry.stored && matchesSource(row, entry));
      const fingerprints = new Set(matches.map((entry) => JSON.stringify(Object.entries(entry.norm.raw).filter(([key]) => key !== "_visa"))));
      if (!matches.length || fingerprints.size > 1) {
        addIssue(plan, item.id, "unmatched_or_ambiguous_row", { table, id: row.id, sourceRow: row.source_row, candidates: matches.length, storedRaw: parseRaw(row.raw_json), sourceCandidates: sourceEntries.filter((entry) => clean(entry.norm.merchant) === clean(row.merchant)).map((entry) => ({ raw: entry.norm.raw, legacy: entry.legacy })) }); continue;
      }
      const entry = matches[0];
      entry.stored = row;
      entry.table = table;
      if (table === "transactions") { mappedTransactions.add(row.id); statement.matchedTransactions++; }
      else statement.matchedDuplicates++;
    }
    for (const entry of sourceEntries) {
      if (!entry.stored && !entry.skipReason) addIssue(plan, item.id, "source_row_missing_from_both_tables", { sourceRow: entry.norm.raw._visa.sourceRow, merchant: entry.norm.merchant });
      entries.push(entry);
    }
  }
  const groups = new Map();
  for (const entry of entries.filter((entry) => !entry.skipReason)) groups.set(entry.norm.dedupeKey, [...(groups.get(entry.norm.dedupeKey) || []), entry]);
  const promotions = new Set();
  for (const [key, group] of groups) {
    const occurrences = new Map();
    for (const entry of group) occurrences.set(entry.importId, (occurrences.get(entry.importId) || 0) + 1);
    const targetCount = Math.max(...occurrences.values());
    const existing = group.filter((entry) => entry.table === "transactions");
    const external = transactions.filter((row) => !mappedTransactions.has(row.id) && row.dedupe_key === key);
    if (existing.length + external.length > targetCount) addIssue(plan, group[0].importId, "existing_transaction_collision", { ids: [...existing.map((entry) => entry.stored.id), ...external.map((row) => row.id)] });
    let missing = Math.max(0, targetCount - existing.length - external.length);
    for (const entry of group.filter((entry) => entry.table === "import_duplicates")) {
      if (missing > 0) { promotions.add(entry); missing--; }
    }
  }
  for (const entry of entries.filter((entry) => entry.stored)) {
    const { stored, table, norm, importId } = entry;
    let kind = "update";
    let after = correctedFields(norm);
    if (entry.skipReason) { kind = "remove"; after = null; }
    else if (promotions.has(entry)) { kind = "recover"; after = recoveredTransaction(entry); }
    else {
      const columns = table === "transactions" ? transactionColumns : duplicateColumns;
      after = Object.fromEntries(columns.map((column) => [column, after[column]]));
      if (columns.every((column) => stored[column] === after[column])) continue;
    }
    plan.actions.push({ kind, table, id: stored.id, importId, sourceRow: norm.raw._visa.sourceRow, reason: entry.skipReason, before: stored, after });
  }
  plan.summary = {
    scannedImports: imports.length, visaStatements: plan.statements.length,
    updateTransactions: plan.actions.filter((a) => a.kind === "update" && a.table === "transactions").length,
    updateDuplicates: plan.actions.filter((a) => a.kind === "update" && a.table === "import_duplicates").length,
    recoveredTransactions: promotions.size,
    removedTransactions: plan.actions.filter((a) => a.kind === "remove" && a.table === "transactions").length,
    removedDuplicates: plan.actions.filter((a) => a.kind === "remove" && a.table === "import_duplicates").length,
    retainedDuplicates: entries.filter((e) => e.table === "import_duplicates" && !e.skipReason && !promotions.has(e)).length,
    changedPaths: plan.files.filter((f) => f.oldPath !== f.newPath || f.before.processed_path !== f.newPath).length,
    unresolved: plan.unresolved.length,
  };
  return plan;
}

/** Commit a verified plan, retaining existing annotations and recalculating balances once. */
export function applyVisaImportRepair(db, plan, { applyRules = applyRulesToTransaction, beforeCommit = null } = {}) {
  if (plan.unresolved.length) throw new Error(`Repair blocked by ${plan.unresolved.length} unresolved issues`);
  return db.transaction(() => {
    if (repairRevision(db) !== plan.revision) throw new Error("Database changed after repair planning");
    const counters = new Map();
    const recovered = [];
    for (const action of plan.actions) {
      if (!["transactions", "import_duplicates"].includes(action.table)) throw new Error("Invalid repair table");
      const delta = counters.get(action.importId) || { inserted: 0, duplicates: 0, total: 0 };
      if (action.kind === "update") {
        const allowed = action.table === "transactions" ? transactionColumns : duplicateColumns;
        db.prepare(`UPDATE ${action.table} SET ${allowed.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`).run(...allowed.map((column) => action.after[column]), action.id);
      } else if (action.kind === "recover") {
        const columns = Object.keys(action.after);
        const id = db.prepare(`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => action.after[column])).lastInsertRowid;
        applyRules(db, id);
        db.prepare("DELETE FROM import_duplicates WHERE id = ?").run(action.id);
        delta.inserted++; delta.duplicates--;
        recovered.push({ duplicateId: action.id, transactionId: Number(id) });
      } else if (action.kind === "remove") {
        db.prepare(`DELETE FROM ${action.table} WHERE id = ?`).run(action.id);
        if (action.table === "transactions") delta.inserted--; else delta.duplicates--;
        delta.total--;
      } else throw new Error("Invalid repair action");
      counters.set(action.importId, delta);
    }
    for (const [id, delta] of counters) db.prepare("UPDATE imports SET rows_inserted = rows_inserted + ?, rows_duplicates = rows_duplicates + ?, rows_total = rows_total + ? WHERE id = ?").run(delta.inserted, delta.duplicates, delta.total, id);
    for (const file of plan.files) db.prepare("UPDATE imports SET processed_path = ? WHERE id = ?").run(file.newPath, file.importId);
    const reindexed = plan.actions.length ? reindexTransactionsChronologically(db) : 0;
    const balances = plan.actions.length ? recalculateTransactionBalances(db) : null;
    if (db.pragma("foreign_key_check").length || db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Database integrity check failed");
    if (beforeCommit) beforeCommit();
    return { recovered, reindexed, balances };
  }).immediate();
}
