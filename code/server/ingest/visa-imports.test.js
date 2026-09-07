import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import XLSX from "xlsx";
import { readVisaTextRows, parseVisaPortal } from "./parsers/creditCardVisaPortalParser.js";
import { normalizeRecord, buildDedupeKey, effectiveTransactionDateSql } from "./normalize.js";
import { planVisaImportRepair, applyVisaImportRepair, repairRevision } from "./repairVisaImports.js";
import { runVisaImportRepair } from "../cli/repair-visa-imports.js";
import { sha256Hex } from "../utils/hash.js";

const source = "כ.אשראי (6688)";
const installment = ["10/10/19", "תדיראן מוצרי צריכה", "₪ 1,550.00", "₪ 43.06", "תשלום 22 מתוך 36 *"];
const purchase = ["01/07/21", "חנות", "₪ 11.24", "₪ 11.24", ""];
const fileName = "6688-08.2021.xls";
function documentRows(rows, billing = "08/2021") {
  return [
    ["פירוט עסקות נכון לתאריך: 31/12/2021"],
    [`פירוט עסקות לכרטיס ויזה זהב, המסתיים בספרות 6688${billing ? `, לתאריך חיוב ${billing}` : ""}`],
    ["תאריך העסקה", "שם בית העסק", "סכום העסקה", "סכום החיוב", "פירוט נוסף"],
    ...rows.map((row) => [...row]),
    ["סה\"כ:", "", "", `₪ ${rows.filter((r) => !r[4]?.includes("עסקה בקליטה")).reduce((n, r) => n + Number(String(r[3] || "0").replace(/[₪,$\s]/g, "")), 0).toFixed(2)}`],
  ];
}
const text = (rows, billing) => documentRows(rows, billing).map((row) => row.join("\t")).join("\r\n");
function parse(rows, billing = "08/2021", name = fileName) {
  const audit = {};
  const records = parseVisaPortal({ wb: null, textRows: readVisaTextRows(Buffer.from(text(rows, billing))), fileName: name, audit, quiet: true });
  return { records, audit };
}
const normalize = (record) => normalizeRecord(record, { sourceFile: fileName, sourceRow: 1 });

test("text encodings preserve decimal charges and Israeli dates", () => {
  const input = text([installment, purchase]);
  const le = Buffer.from(`\uFEFF${input}`, "utf16le");
  const be = Buffer.from(le).swap16();
  for (const buffer of [Buffer.from(input), Buffer.from(`\uFEFF${input}`), le, be, Buffer.from(input, "utf16le")]) {
    const rows = readVisaTextRows(buffer);
    assert.equal(rows[3][3], "₪ 43.06");
    const out = parseVisaPortal({ wb: null, textRows: rows, fileName, quiet: true });
    assert.equal(normalize(out[0]).amountSigned, -43.06);
    assert.equal(out[0].txnDate, "2021-08-10");
    assert.equal(out[0].originalTxnDate, "2019-10-10");
    assert.equal(out[0].postingDate, null);
    assert.equal(out[1].txnDate, "2021-07-01");
  }
});

test("quoted CSV preserves commas, escaped quotes and source line numbers", () => {
  const rows = documentRows([[...purchase.slice(0, 1), 'עסק, "שם"\nנוסף', ...purchase.slice(2)], installment]);
  const csv = rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
  const out = parseVisaPortal({ wb: null, textRows: readVisaTextRows(Buffer.from(csv)), fileName, quiet: true });
  assert.equal(out[0].merchant, 'עסק, "שם"\nנוסף');
  assert.equal(out[1].raw._visa.sourceLine, 6);
});

test("exact charge dates win and ordinary purchase dates survive normalization and sorting", () => {
  const rows = documentRows([installment, ["01/06/21", ...purchase.slice(1)]], "02/08/2021");
  rows[2].push("תאריך חיוב"); rows[3].push("05/08/2021");
  const out = parseVisaPortal({ wb: null, textRows: rows, fileName, quiet: true });
  assert.equal(out[0].txnDate, "2021-08-05");
  assert.equal(out[0].postingDate, "2021-08-05");
  assert.equal(out[0].raw._visa.dateDerived, false);
  assert.equal(normalize(out[1]).txnDate, "2021-06-01");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE transactions(txn_date TEXT, posting_date TEXT, raw_json TEXT)");
  db.prepare("INSERT INTO transactions VALUES (?, ?, ?)").run("2021-06-01", "2021-08-02", JSON.stringify(out[1].raw));
  assert.equal(db.prepare(`SELECT ${effectiveTransactionDateSql()} AS d FROM transactions`).get().d, "2021-06-01");
  db.close();
});

test("month inference clamps days, respects leap years, and rejects conflicting or missing periods", () => {
  const row = ["31/01/19", ...installment.slice(1)];
  assert.equal(parse([row], "02/2021", "6688-02.2021.xls").records[0].txnDate, "2021-02-28");
  assert.equal(parse([row], "02/2020", "6688-02.2020.xls").records[0].txnDate, "2020-02-29");
  assert.equal(parse([installment], "").records[0].txnDate, "2021-08-10");
  assert.throws(() => parse([installment], "09/2021"), /conflicts/);
  assert.throws(() => parse([installment], "", "no-period.xls"), /Missing Visa billing/);
});

test("charge amount controls currency values, refunds and skipped pending/zero rows", () => {
  const rows = [["25/02/21", "ריבית", "$ 11.24", "₪ 0.03", ""], ["26/02/21", "זיכוי", "₪ -12.34", "₪ -12.34", "זיכוי"], ["01/07/21", "ממתין", "₪ 100", "", "עסקה בקליטה"], ["01/07/21", "אפס", "₪ 100", "₪ 0.00", ""]];
  const { records, audit } = parse(rows);
  assert.equal(records.length, 2);
  assert.equal(normalize(records[0]).amountSigned, -0.03);
  assert.equal(normalize(records[0]).originalAmountSigned, -11.24);
  assert.equal(normalize(records[1]).amountSigned, 12.34);
  assert.deepEqual(audit.rows.slice(2).map((entry) => entry.skipReason), ["pending", "zero_charge"]);
  assert.throws(() => parse([[...purchase.slice(0, 3), "invalid", ""]]), /Invalid Visa charge/);
});

test("real XLSX remains a workbook and installments have stable monthly identities", () => {
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(documentRows([installment])), "עסקאות");
  const binary = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  assert.equal(readVisaTextRows(binary), null);
  const out = parseVisaPortal({ wb: XLSX.read(binary), fileName, quiet: true });
  const august = normalize(out[0]);
  const september = normalize(parse([installment], "09/2021", "6688-09.2021.xls").records[0]);
  assert.notEqual(august.dedupeKey, september.dedupeKey);
  assert.equal(august.dedupeKey, buildDedupeKey({ ...august, txnDate: "2021-08-02", postingDate: "2021-08-02" }));
});

async function fixture(t, rows = [installment, purchase], kinds = ["duplicate", "transaction"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "visa-repair-test-"));
  t.after(async () => { assert.ok(path.basename(root).startsWith("visa-repair-test-")); await fs.rm(root, { recursive: true, force: true }); });
  const processedDir = path.join(root, "processed");
  const oldPath = path.join(processedDir, source, "2021-01", fileName);
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  const buffer = Buffer.from(`\uFEFF${text(rows)}`, "utf16le"); await fs.writeFile(oldPath, buffer);
  const dbPath = path.join(root, "finance.sqlite");
  const db = new Database(dbPath);
  db.exec(await fs.readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO categories(id,name_he,created_at) VALUES (1,'manual','2020-01-01'); INSERT INTO tags(id,name_he,exclude_from_calculations,created_at) VALUES(1,'excluded',1,'2020-01-01')");
  db.prepare("INSERT INTO imports(id,file_name,source,file_sha256,started_at,rows_total,rows_inserted,rows_duplicates,processed_path) VALUES(1,?,?,?,?,?,?,?,?)").run(fileName, source, sha256Hex(buffer), "2021-09-01", rows.length, kinds.filter((k) => k === "transaction").length, kinds.filter((k) => k === "duplicate").length, oldPath);
  const audit = {}; parseVisaPortal({ wb: null, textRows: readVisaTextRows(buffer), fileName, audit, quiet: true });
  const legacy = XLSX.read(buffer, { type: "buffer" });
  const legacyRows = XLSX.utils.sheet_to_json(legacy.Sheets[legacy.SheetNames[0]], { header: 1, defval: "", raw: true });
  for (let i = 0; i < audit.rows.length; i++) {
    if (!kinds[i]) continue;
    const norm = normalize(audit.rows[i].record);
    const raw = Object.fromEntries(legacyRows[2].map((key, c) => [key, legacyRows[i + 3][c]]));
    const fields = { source, source_file: fileName, source_row: i + 1, account_ref: "6688", txn_date: "2019-10-10", posting_date: null, merchant: norm.merchant, description: `manual ${norm.merchant}`, category_raw: null, amount_signed: i === 0 ? -52383 : norm.amountSigned, currency: "ILS", direction: "expense", raw_json: JSON.stringify(raw), created_at: "2021-09-01" };
    if (kinds[i] === "duplicate") fields.import_id = 1;
    else Object.assign(fields, { dedupe_key: `legacy-${i}`, category_id: 1, tags: "[1]", notes: "keep my notes" });
    const columns = Object.keys(fields);
    db.prepare(`INSERT INTO ${kinds[i] === "duplicate" ? "import_duplicates" : "transactions"} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(fields));
  }
  db.prepare("INSERT INTO transactions(source,txn_date,amount_signed,real_balance_after,currency,direction,dedupe_key,raw_json,created_at) VALUES('bank','2018-01-01',0,100,'ILS','income','bank','{}','2018-01-01')").run();
  db.close();
  return { root, dbPath, processedDir, oldPath };
}

test("repair dry-run, rollback, manual annotations, recovery, paths and idempotency", async (t) => {
  const f = await fixture(t);
  const db = new Database(f.dbPath);
  const revision = repairRevision(db);
  const plan = await planVisaImportRepair(db, f);
  assert.equal(plan.unresolved.length, 0, JSON.stringify(plan.unresolved));
  assert.equal(plan.summary.recoveredTransactions, 1);
  assert.equal(repairRevision(db), revision);
  assert.throws(() => applyVisaImportRepair(db, plan, { applyRules: () => {}, beforeCommit: () => { throw new Error("rollback test"); } }), /rollback test/);
  assert.equal(repairRevision(db), revision);
  db.close();
  const result = await runVisaImportRepair({ ...f, apply: true });
  assert.equal(result.verification, "passed");
  const fixed = new Database(f.dbPath);
  const row = fixed.prepare("SELECT * FROM transactions WHERE source_row = 1 AND source = ?").get(source);
  assert.equal(row.amount_signed, -43.06); assert.equal(row.txn_date, "2021-08-10"); assert.equal(row.original_txn_date, "2019-10-10");
  const kept = fixed.prepare("SELECT * FROM transactions WHERE source_row = 2 AND source = ?").get(source);
  assert.equal(kept.category_id, 1); assert.equal(kept.tags, "[1]"); assert.equal(kept.notes, "keep my notes"); assert.equal(kept.description, "manual חנות");
  assert.equal(kept.affected_balance_after, 100); assert.equal(row.affected_balance_after, 56.94);
  const storedPath = fixed.prepare("SELECT processed_path FROM imports WHERE id = 1").get().processed_path;
  assert.ok(storedPath.includes("2021-08")); assert.equal(sha256Hex(await fs.readFile(storedPath)), plan.files[0].sha256);
  assert.equal(fixed.prepare("SELECT COUNT(*) AS n FROM import_duplicates").get().n, 0);
  fixed.close();
  assert.equal((await runVisaImportRepair({ ...f, apply: true })).changed, false);
  await assert.rejects(fs.access(f.oldPath), { code: "ENOENT" });
});

test("same-file identical occurrences remain distinct and skipped rows do not shift matches", async (t) => {
  const pending = ["01/07/21", "ממתין", "₪ 100", "", "עסקה בקליטה"];
  const f = await fixture(t, [pending, installment, installment], [null, "transaction", "duplicate"]);
  const db = new Database(f.dbPath); const plan = await planVisaImportRepair(db, f);
  assert.equal(plan.unresolved.length, 0, JSON.stringify(plan.unresolved)); assert.equal(plan.summary.recoveredTransactions, 1);
  assert.equal(plan.actions.find((a) => a.kind === "recover").sourceRow, 6);
  db.close();
});

test("source-confirmed pending and zero rows are removed; source-only missing rows block repair", async (t) => {
  const f = await fixture(t, [purchase, ["01/07/21", "ממתין", "₪ 100", "", "עסקה בקליטה"], ["01/07/21", "אפס", "₪ 100", "₪ 0", ""]], ["transaction", "transaction", "duplicate"]);
  const db = new Database(f.dbPath); const plan = await planVisaImportRepair(db, f);
  assert.equal(plan.summary.removedTransactions, 1); assert.equal(plan.summary.removedDuplicates, 1);
  db.prepare("DELETE FROM transactions WHERE source = ? AND source_row = 1").run(source);
  const missing = await planVisaImportRepair(db, f);
  assert.ok(missing.unresolved.some((i) => i.reason === "source_row_missing_from_both_tables"));
  assert.throws(() => applyVisaImportRepair(db, missing), /blocked/); db.close();
});

test("changed files, destination collisions and stale plans cannot apply", async (t) => {
  const f = await fixture(t); const db = new Database(f.dbPath);
  const plan = await planVisaImportRepair(db, f);
  db.prepare("UPDATE transactions SET notes = 'new edit' WHERE source = ?").run(source);
  assert.throws(() => applyVisaImportRepair(db, plan), /Database changed/);
  await fs.mkdir(path.dirname(plan.files[0].newPath), { recursive: true }); await fs.writeFile(plan.files[0].newPath, "different file");
  assert.ok((await planVisaImportRepair(db, f)).unresolved.some((i) => i.reason === "destination_collision"));
  await fs.writeFile(f.oldPath, "changed");
  assert.ok((await planVisaImportRepair(db, f)).unresolved.some((i) => i.reason === "source_hash_changed")); db.close();
});

test("interrupted file staging and post-commit cleanup resume safely", async (t) => {
  for (const committed of [false, true]) {
    const f = await fixture(t); const db = new Database(f.dbPath);
    const plan = await planVisaImportRepair(db, f); const file = plan.files[0];
    await fs.mkdir(path.dirname(file.newPath), { recursive: true }); await fs.copyFile(file.oldPath, file.newPath);
    if (committed) applyVisaImportRepair(db, plan, { applyRules: () => {} });
    const journalDir = `${f.dbPath}.visa-repairs`; await fs.mkdir(journalDir);
    await fs.writeFile(path.join(journalDir, "interrupted.json"), JSON.stringify({ status: "staged", createdCopies: [file.newPath], plan })); db.close();
    const result = await runVisaImportRepair({ ...f, apply: true });
    assert.equal(result.unresolved, 0);
    await assert.rejects(fs.access(file.oldPath), { code: "ENOENT" });
    assert.equal(sha256Hex(await fs.readFile(file.newPath)), file.sha256);
  }
});

test("true cross-export duplicates are retained and existing collisions are reported", async (t) => {
  const f = await fixture(t, [installment], ["transaction"]);
  const db = new Database(f.dbPath);
  const name = "6688-copy-08.2021.xls";
  const copyPath = path.join(path.dirname(f.oldPath), name);
  const buffer = Buffer.from(`\uFEFF${text([installment]).replace("31/12/2021", "30/12/2021")}`, "utf16le");
  await fs.writeFile(copyPath, buffer);
  db.prepare("INSERT INTO imports(id,file_name,source,file_sha256,started_at,rows_total,rows_inserted,rows_duplicates,processed_path) VALUES(2,?,?,?,'2021-09-02',1,0,1,?)").run(name, source, sha256Hex(buffer), copyPath);
  db.prepare("INSERT INTO import_duplicates(import_id,source,source_file,source_row,account_ref,txn_date,merchant,description,amount_signed,currency,direction,raw_json,created_at) SELECT 2,source,?,source_row,account_ref,txn_date,merchant,description,amount_signed,currency,direction,raw_json,created_at FROM transactions WHERE source = ?").run(name, source);
  const plan = await planVisaImportRepair(db, f);
  assert.equal(plan.unresolved.length, 0, JSON.stringify(plan.unresolved));
  assert.equal(plan.summary.retainedDuplicates, 1); assert.equal(plan.summary.recoveredTransactions, 0);
  db.prepare("INSERT INTO transactions(source,source_file,source_row,account_ref,txn_date,merchant,description,amount_signed,currency,direction,raw_json,created_at,dedupe_key) SELECT source,source_file,source_row,account_ref,txn_date,merchant,description,amount_signed,currency,direction,raw_json,created_at,'second-legacy' FROM import_duplicates").run();
  db.exec("DELETE FROM import_duplicates");
  assert.ok((await planVisaImportRepair(db, f)).unresolved.some((i) => i.reason === "existing_transaction_collision"));
  db.close();
});

test("future imports preserve same-file repeats and reject repeated export occurrences", async (t) => {
  const f = await fixture(t, [installment], [null]);
  const db = new Database(f.dbPath); db.exec("DELETE FROM imports"); db.close();
  const inbox = path.join(f.root, "inbox"); await fs.mkdir(inbox);
  const names = [fileName, "6688-export-08.2021.xls", "6688-extra-08.2021.xls"];
  for (let i = 0; i < names.length; i++) await fs.writeFile(path.join(inbox, names[i]), Buffer.from(`\uFEFF${text(Array.from({ length: i === 2 ? 3 : 2 }, () => installment)).replace("31/12/2021", `${28 + i}/12/2021`)}`, "utf16le"));
  const script = `import path from 'node:path'; import { processFile } from './server/ingest/processFile.js'; import { closeDb } from './server/db/db.js'; const log = console.log; console.log = () => {}; const results=[]; for(const name of ${JSON.stringify(names)}) results.push(await processFile(path.join(process.env.INBOX_DIR,name))); closeDb(); log(JSON.stringify(results));`;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DB_PATH: f.dbPath, PROCESSED_DIR: f.processedDir, INBOX_DIR: inbox, LOG_LEVEL: "silent" } }));
  assert.deepEqual(result.map((r) => [r.rowsInserted, r.rowsDuplicates]), [[2, 0], [0, 2], [1, 2]]);
  const fixed = new Database(f.dbPath);
  assert.equal(fixed.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = ?").get(source).n, 3);
  assert.ok(fixed.prepare("SELECT processed_path FROM imports").all().every((r) => r.processed_path.includes("2021-08")));
  fixed.close();
});

test("locked obsolete files leave resumable cleanup without blocking verification", async (t) => {
  const f = await fixture(t);
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (filePath) => {
    if (filePath === f.oldPath) throw Object.assign(new Error("Workbook open"), { code: "EBUSY" });
    return unlink(filePath);
  });
  const result = await runVisaImportRepair({ ...f, apply: true });
  assert.equal(result.verification, "passed");
  assert.deepEqual(result.cleanupPending, [{ filePath: f.oldPath, reason: "EBUSY" }]);
  t.mock.restoreAll();
  const resumed = await runVisaImportRepair({ ...f, apply: true });
  assert.deepEqual(resumed.cleanupPending, []);
  assert.equal(resumed.changed, false);
  await assert.rejects(fs.access(f.oldPath), { code: "ENOENT" });
});
