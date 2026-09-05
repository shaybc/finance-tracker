import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import multer from "multer";
import { z } from "zod";
import { closeDb, getDb } from "../db/db.js";
import { migrateDb } from "../db/migrate.js";
import { reindexTransactionsChronologically } from "../db/transactions.js";
import {
  applyRulesToTransaction,
  applySingleRuleToTransaction,
  getRuleMatchEffects,
} from "../ingest/categorize.js";
import { buildDedupeKey } from "../ingest/normalize.js";
import { recalculateTransactionBalances } from "../db/balances.js";
import { config } from "../config.js";
import { sha256Hex } from "../utils/hash.js";
import { extractCardLast4FromFileName } from "../utils/source.js";

export const api = express.Router();

const CREDIT_CARD_SOURCES_FILTER = "__credit_cards__";

api.get("/health", (req, res) => res.json({ ok: true }));

const categorySchema = z.object({
  id: z.number().int(),
  name_he: z.string().min(1),
  icon: z.string().nullable().optional(),
  direction: z.enum(["expense", "income"]).optional().nullable(),
  type: z.enum(["expense", "income"]).optional().nullable(),
  created_at: z.string().optional().nullable(),
});

const tagSchema = z.object({
  id: z.number().int(),
  name_he: z.string().min(1),
  icon: z.string().nullable().optional(),
  hide_from_transactions: z.union([z.boolean(), z.number().int()]).optional(),
  exclude_from_calculations: z.union([z.boolean(), z.number().int()]).optional(),
  use_for_forecast: z.union([z.boolean(), z.number().int()]).optional(),
  created_at: z.string().optional().nullable(),
});

const ruleSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  enabled: z.union([z.boolean(), z.number().int()]).optional(),
  match_field: z.enum(["merchant", "description", "category_raw"]),
  match_type: z.enum(["contains", "regex", "equals"]),
  pattern: z.string().min(1),
  source: z.string().nullable().optional(),
  direction: z.enum(["expense", "income"]).nullable().optional(),
  category_id: z.number().int().nullable().optional(),
  tag_ids: z.array(z.number().int()).optional(),
  amount_min: z.number().nullable().optional(),
  amount_max: z.number().nullable().optional(),
  run_on_categorized: z.union([z.boolean(), z.number().int()]).optional(),
  applied_count: z.number().int().optional(),
  created_at: z.string().optional().nullable(),
});

function parseTagIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => !Number.isNaN(item));
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => Number(item)).filter((item) => !Number.isNaN(item));
      }
    } catch {
      // ignore parse errors
    }
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number(item))
      .filter((item) => !Number.isNaN(item));
  }
  return [];
}

function normalizeFlag(value, fallback = 0) {
  if (typeof value === "number") return value ? 1 : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  return fallback;
}

function getSettingValue(db, key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

function setSettingValue(db, key, value) {
  if (value === null || value === undefined || value === "") {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

const transactionPageSizeOptions = new Set([
  "10",
  "20",
  "50",
  "100",
  "200",
  "500",
  "1000",
  "last_30_days",
  "last_60_days",
  "last_half_year",
  "last_year",
]);

const dashboardRangeOptions = new Set(["custom", "30", "60", "half-year", "year"]);
const transactionColorDefaults = {
  enabled: 1,
  incomeColor: "#16a34a",
  expenseColor: "#000000",
};
const hexColorPattern = /^#(?:[0-9a-f]{3}){1,2}$/i;

function parseBooleanSetting(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return 1;
  }
  if (normalized === "0" || normalized === "false") {
    return 0;
  }
  return fallback;
}

function resolveHexColor(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim();
  if (!hexColorPattern.test(normalized)) {
    return fallback;
  }
  return normalized;
}

async function copyDir(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath);
    } else {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

function buildBackupFolderName(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `finance_tracker_db_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      const tmpDir = path.join(config.dataDir, "tmp", "uploads");
      try {
        await fs.mkdir(tmpDir, { recursive: true });
        cb(null, tmpDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (req, file, cb) => {
      const safeName = path.basename(normalizeOriginalName(file.originalname) || "upload");
      const stamp = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${stamp}-${safeName}`);
    },
  }),
});

api.get("/imports", (req, res) => {
  const db = getDb();
  const pageNum = Math.max(1, Number(req.query.page) || 1);
  const pageSizeNum = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
  const offset = (pageNum - 1) * pageSizeNum;
  const totalRow = db.prepare("SELECT COUNT(*) AS total FROM imports").get();
  const items = db
    .prepare("SELECT * FROM imports ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(pageSizeNum, offset);
  res.json({
    items,
    total: totalRow?.total ?? 0,
    page: pageNum,
    pageSize: pageSizeNum,
  });
});

api.get("/sources", (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT DISTINCT source FROM transactions ORDER BY source").all();
  const items = rows.map((row) => row.source).filter(Boolean);
  res.json({ items });
});

api.post("/imports/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "missing_file" });
    return;
  }

  const tempPath = req.file.path;
  const originalName = path.basename(normalizeOriginalName(req.file.originalname) || "import.xlsx");
  const ext = path.extname(originalName).toLowerCase();

  if (![".xlsx", ".xls"].includes(ext)) {
    await fs.unlink(tempPath).catch(() => {});
    res.status(400).json({ error: "invalid_extension" });
    return;
  }

  try {
    const buf = await fs.readFile(tempPath);
    const fileSha = sha256Hex(buf);
    const db = getDb();
    const existing = db.prepare("SELECT id FROM imports WHERE file_sha256 = ?").get(fileSha);
    if (existing) {
      await fs.unlink(tempPath).catch(() => {});
      res.status(409).json({ error: "already_imported" });
      return;
    }

    await fs.mkdir(config.inboxDir, { recursive: true });
    const inboxPath = await resolveInboxPath(originalName);
    await fs.copyFile(tempPath, inboxPath);
    await fs.unlink(tempPath).catch(() => {});
    res.json({ ok: true, file_name: path.basename(inboxPath) });
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    res.status(500).json({ error: "server_error" });
  }
});

api.get("/imports/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const item = db.prepare("SELECT * FROM imports WHERE id = ?").get(id);

    if (!item) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const stats = db
      .prepare(
        `
        SELECT MIN(txn_date) AS first_entry_date, MAX(txn_date) AS last_entry_date
        FROM (
          SELECT txn_date FROM transactions WHERE source_file = ? AND source = ?
          UNION ALL
          SELECT txn_date FROM import_duplicates WHERE import_id = ?
        )
      `
      )
      .get(item.file_name, item.source, id);

    const duplicates = db
      .prepare(
        `
        SELECT id, txn_date, merchant, description, category_raw, amount_signed, currency, source_row
        FROM import_duplicates
        WHERE import_id = ?
        ORDER BY source_row ASC, id ASC
      `
      )
      .all(id);

    const accountRow = db
      .prepare(
        "SELECT account_ref FROM transactions WHERE source_file = ? AND source = ? AND account_ref IS NOT NULL LIMIT 1"
      )
      .get(item.file_name, item.source);
    const dupAccountRow = accountRow
      ? null
      : db
          .prepare(
            "SELECT account_ref FROM import_duplicates WHERE import_id = ? AND account_ref IS NOT NULL LIMIT 1"
          )
          .get(id);

    let accountRef = accountRow?.account_ref || dupAccountRow?.account_ref || null;
    let cardLast4 = null;
    if (item.source !== "bank") {
      if (accountRef) {
        cardLast4 = accountRef;
      } else {
        cardLast4 = extractCardLast4FromFileName(item.file_name);
      }
    }

    const filePath = await resolveImportFilePath(item);
    const fileAvailable = Boolean(filePath);

    res.json({
      item,
      stats: {
        first_entry_date: stats?.first_entry_date || null,
        last_entry_date: stats?.last_entry_date || null,
      },
      duplicates,
      account_ref: item.source === "bank" ? accountRef : null,
      card_last4: item.source === "bank" ? null : cardLast4,
      file_available: fileAvailable,
      file_url: fileAvailable ? `/api/imports/${id}/file` : null,
    });
  } catch (error) {
    res.status(500).json({ error: "server_error" });
  }
});

api.post("/imports/:id/duplicates/:dupId/accept", (req, res) => {
  try {
    const importId = Number(req.params.id);
    const dupId = Number(req.params.dupId);
    const db = getDb();
    const item = db.prepare("SELECT * FROM imports WHERE id = ?").get(importId);

    if (!item) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const dup = db
      .prepare(
        `SELECT id, import_id, source, source_file, source_row, account_ref, txn_date, posting_date, merchant, description, category_raw, amount_signed, currency, direction, raw_json, created_at
        FROM import_duplicates
        WHERE id = ? AND import_id = ?`
      )
      .get(dupId, importId);

    if (!dup) {
      res.status(404).json({ error: "duplicate_not_found" });
      return;
    }

    const amountSigned = Number(dup.amount_signed ?? 0);
    const currency = dup.currency || "ILS";
    const direction = dup.direction || (amountSigned < 0 ? "expense" : "income");
    const dedupeKey = buildDedupeKey({
      source: dup.source,
      accountRef: dup.account_ref,
      txnDate: dup.txn_date,
      postingDate: dup.posting_date,
      merchant: dup.merchant,
      description: dup.description,
      amountSigned,
      currency,
    });

    const insertTx = db.prepare(
      `INSERT INTO transactions
      (source, source_file, source_row, intra_day_index, account_ref, txn_date, posting_date, merchant, description, category_raw, original_txn_date, original_amount_signed, amount_signed, real_balance_after, affected_balance_after, balance_amount, balance_is_calculated, currency, direction, category_id, notes, tags, dedupe_key, raw_json, created_at)
      VALUES
      (@source, @sourceFile, @sourceRow, @intraDayIndex, @accountRef, @txnDate, @postingDate, @merchant, @description, @categoryRaw, @originalTxnDate, @originalAmountSigned, @amountSigned, @realBalanceAfter, @affectedBalanceAfter, @balanceAmount, @balanceIsCalculated, @currency, @direction, NULL, NULL, @tags, @dedupeKey, @rawJson, @createdAt)`
    );

    const insertedId = db.transaction(() => {
      const result = insertTx.run({
        source: dup.source,
        sourceFile: dup.source_file,
        sourceRow: dup.source_row,
        intraDayIndex: dup.source_row,
        accountRef: dup.account_ref,
        txnDate: dup.txn_date,
        postingDate: dup.posting_date,
        merchant: dup.merchant,
        description: dup.description,
        categoryRaw: dup.category_raw,
        originalTxnDate: null,
        originalAmountSigned: null,
        amountSigned,
        realBalanceAfter: null,
        affectedBalanceAfter: null,
        balanceAmount: null,
        balanceIsCalculated: 0,
        currency,
        direction,
        tags: null,
        dedupeKey,
        rawJson: dup.raw_json || "{}",
        createdAt: dup.created_at || new Date().toISOString(),
      });
      applyRulesToTransaction(db, result.lastInsertRowid);
      db.prepare("DELETE FROM import_duplicates WHERE id = ?").run(dupId);
      db.prepare(
        "UPDATE imports SET rows_duplicates = MAX(rows_duplicates - 1, 0), rows_inserted = rows_inserted + 1 WHERE id = ?"
      ).run(importId);
      return result.lastInsertRowid;
    })();

    reindexTransactionsChronologically(db);
    recalculateTransactionBalances(db);

    res.json({ ok: true, transaction_id: insertedId });
  } catch (error) {
    res.status(500).json({ error: "server_error" });
  }
});

api.get("/imports/:id/file", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const item = db.prepare("SELECT * FROM imports WHERE id = ?").get(id);

    if (!item) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const filePath = await resolveImportFilePath(item);
    if (!filePath) {
      res.status(404).json({ error: "file_missing" });
      return;
    }

    const resolved = path.resolve(filePath);
    const root = path.resolve(config.processedDir);
    if (!resolved.startsWith(root)) {
      res.status(400).json({ error: "invalid_path" });
      return;
    }

    res.download(resolved, item.file_name);
  } catch (error) {
    res.status(500).json({ error: "server_error" });
  }
});

api.delete("/imports/:id", async (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const item = db.prepare("SELECT * FROM imports WHERE id = ?").get(id);

  if (!item) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  await removeProcessedFile(item);

  const deletedTransactions = db.transaction(() => {
    let where = "source_file = ?";
    const params = [item.file_name];
    if (item.started_at) {
      where += " AND created_at >= ?";
      params.push(item.started_at);
    }
    if (item.finished_at) {
      where += " AND created_at <= ?";
      params.push(item.finished_at);
    }

    const tx = db.prepare(`DELETE FROM transactions WHERE ${where}`).run(...params);
    db.prepare("DELETE FROM imports WHERE id = ?").run(id);
    return tx.changes;
  })();

  reindexTransactionsChronologically(db);
  recalculateTransactionBalances(db);

  res.json({ ok: true, deleted_transactions: deletedTransactions });
});

function isPathInsideRoot(filePath, rootPath) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(rootPath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function decodeOriginalEntryFile(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (buffer.subarray(0, Math.min(buffer.length, 2048)).includes(0)) return null;
  return buffer.toString("utf8");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseRawJson(rawJson) {
  try {
    return JSON.parse(rawJson || "{}");
  } catch {
    return {};
  }
}

function normalizeEntrySearchText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function findOriginalEntryLineIndex(lines, transaction) {
  const raw = parseRawJson(transaction.raw_json);
  const rawValues = Object.values(raw)
    .map(normalizeEntrySearchText)
    .filter((value) => value.length >= 2);
  const identityValues = [transaction.merchant, transaction.description]
    .map(normalizeEntrySearchText)
    .filter((value) => value.length >= 2);

  for (let i = 0; i < lines.length; i++) {
    const line = normalizeEntrySearchText(lines[i]);
    if (!line) continue;
    const hasIdentity = identityValues.length === 0 || identityValues.some((value) => line.includes(value));
    if (!hasIdentity) continue;
    const matchedRawValues = rawValues.filter((value) => line.includes(value)).length;
    if (matchedRawValues >= Math.min(2, rawValues.length)) return i;
  }

  const fallbackIndex = Number(transaction.source_row) - 1;
  return Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < lines.length ? fallbackIndex : -1;
}

function renderOriginalEntryHtml({ transaction, fileName, filePath, text }) {
  const lines = text.split(/\r?\n/);
  const highlightedIndex = findOriginalEntryLineIndex(lines, transaction);
  const renderedLines = lines.map((line, index) => {
    const isHighlighted = index === highlightedIndex;
    return `<div${isHighlighted ? ' id="original-entry"' : ''} class="line${isHighlighted ? ' highlighted' : ''}"><span class="line-number">${index + 1}</span><code>${escapeHtml(line || " ")}</code></div>`;
  }).join("");

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>רשומה מקורית - ${escapeHtml(fileName)}</title>
  <style>
    body { margin: 0; background: #f6f8fb; color: #0f172a; font-family: Arial, sans-serif; }
    header { position: sticky; top: 0; z-index: 2; background: #fff; border-bottom: 1px solid #dbe4f0; padding: 14px 22px; box-shadow: 0 4px 16px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 6px; font-size: 20px; }
    .meta { color: #64748b; font-size: 13px; }
    main { direction: ltr; padding: 18px 22px 32px; }
    .viewer { overflow: auto; border: 1px solid #dbe4f0; border-radius: 12px; background: #fff; box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04); }
    .line { display: flex; min-width: max-content; border-bottom: 1px solid #eef2f7; white-space: pre; }
    .line-number { position: sticky; left: 0; min-width: 64px; padding: 6px 10px; border-right: 1px solid #e2e8f0; background: #f8fafc; color: #64748b; text-align: right; user-select: none; }
    code { padding: 6px 12px; font-family: Consolas, "Courier New", monospace; font-size: 13px; unicode-bidi: plaintext; }
    .highlighted { background: #fff7ed; outline: 2px solid #f59e0b; outline-offset: -2px; }
    .highlighted .line-number { background: #ffedd5; color: #9a3412; font-weight: 700; }
  </style>
</head>
<body>
  <header>
    <h1>רשומה מקורית</h1>
    <div class="meta">${escapeHtml(fileName)} · שורת מקור ${escapeHtml(transaction.source_row || "-")} · ${escapeHtml(filePath)}</div>
  </header>
  <main>
    <div class="viewer">${renderedLines}</div>
  </main>
  <script>
    const entry = document.getElementById("original-entry");
    if (entry) entry.scrollIntoView({ block: "center", inline: "nearest" });
  </script>
</body>
</html>`;
}
function renderOriginalEntryMissingHtml({ transaction, fileItem }) {
  const fileName = fileItem?.file_name || transaction.source_file || "-";
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>רשומה מקורית חסרה - ${escapeHtml(fileName)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fb; color: #0f172a; font-family: Arial, sans-serif; }
    main { max-width: 760px; border: 1px solid #dbe4f0; border-radius: 16px; background: #fff; padding: 28px 32px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { margin: 8px 0; color: #475569; line-height: 1.65; }
    dl { margin: 18px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 8px 18px; }
    dt { color: #64748b; }
    dd { margin: 0; direction: ltr; unicode-bidi: plaintext; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>לא ניתן להציג את הרשומה המקורית</h1>
    <p>קובץ המקור המעובד לא נמצא בתיקיית processed, ולכן אי אפשר לפתוח את הרשומה המקורית מתוך האפליקציה.</p>
    <dl>
      <dt>קובץ</dt><dd>${escapeHtml(fileName)}</dd>
      <dt>מקור</dt><dd>${escapeHtml(fileItem?.source || transaction.source || "-")}</dd>
      <dt>שורת מקור</dt><dd>${escapeHtml(transaction.source_row || "-")}</dd>
      <dt>תנועה</dt><dd>${escapeHtml(transaction.merchant || transaction.description || "-")}</dd>
    </dl>
  </main>
</body>
</html>`;
}
async function resolveImportFilePath(item) {
  if (item.processed_path) {
    try {
      await fs.access(item.processed_path);
      return item.processed_path;
    } catch {}
  }

  return findProcessedFile(item);
}

function normalizeOriginalName(originalName) {
  if (!originalName) return "";
  try {
    return Buffer.from(originalName, "latin1").toString("utf8");
  } catch {
    return originalName;
  }
}

async function resolveInboxPath(fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(config.inboxDir, fileName);

  try {
    await fs.access(candidate);
  } catch {
    return candidate;
  }

  const stamp = Date.now();
  for (let i = 0; i < 1000; i++) {
    const suffix = i === 0 ? `${stamp}` : `${stamp}_${i}`;
    candidate = path.join(config.inboxDir, `${base}__${suffix}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }

  return path.join(config.inboxDir, `${base}__${stamp}_${Math.random().toString(16).slice(2)}${ext}`);
}

async function findProcessedFile(item) {
  const sourceDir = path.join(config.processedDir, item.source);
  const fileName = item.file_name;
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const matches = (name) => name === fileName || (name.startsWith(`${base}__`) && name.endsWith(ext));

  try {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && matches(entry.name)) {
        return path.join(sourceDir, entry.name);
      }
      if (entry.isDirectory()) {
        const nestedDir = path.join(sourceDir, entry.name);
        try {
          const nestedEntries = await fs.readdir(nestedDir, { withFileTypes: true });
          for (const nested of nestedEntries) {
            if (nested.isFile() && matches(nested.name)) {
              return path.join(nestedDir, nested.name);
            }
          }
        } catch {}
      }
    }
  } catch {}

  return null;
}

async function removeProcessedFile(item) {
  const filePath = await resolveImportFilePath(item);
  if (!filePath) {
    return;
  }

  const resolvedFilePath = path.resolve(filePath);
  const processedRoot = path.resolve(config.processedDir);
  if (!resolvedFilePath.startsWith(processedRoot)) {
    return;
  }

  try {
    await fs.unlink(resolvedFilePath);
  } catch {
    return;
  }

  const parentDir = path.dirname(resolvedFilePath);
  if (parentDir === processedRoot) {
    return;
  }

  try {
    const remaining = await fs.readdir(parentDir);
    if (remaining.length === 0) {
      await fs.rmdir(parentDir);
    }
  } catch {}
}

api.get("/categories", (req, res) => {
  const db = getDb();
  const items = db.prepare("SELECT * FROM categories ORDER BY name_he ASC").all();
  res.json({ items });
});

api.post("/categories", express.json(), (req, res) => {
  const schema = z.object({
    name_he: z.string().min(1),
    icon: z.string().optional().nullable(),
    direction: z.enum(["expense", "income"]).optional(),
  });
  const body = schema.parse(req.body);

  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare("INSERT INTO categories(name_he, icon, direction, created_at) VALUES (?, ?, ?, ?)")
    .run(body.name_he.trim(), body.icon || null, body.direction || "expense", now);

  const item = db.prepare("SELECT * FROM categories WHERE id = ?").get(row.lastInsertRowid);
  res.json({ item });
});

api.patch("/categories/:id", express.json(), (req, res) => {
  const id = Number(req.params.id);
  const schema = z.object({
    name_he: z.string().min(1),
    icon: z.string().optional().nullable(),
    direction: z.enum(["expense", "income"]).optional(),
  });
  const body = schema.parse(req.body);

  const db = getDb();
  const existing = db.prepare("SELECT direction FROM categories WHERE id = ?").get(id);
  const nextDirection = body.direction || existing?.direction || "expense";
  db.prepare("UPDATE categories SET name_he = ?, icon = ?, direction = ? WHERE id = ?")
    .run(body.name_he.trim(), body.icon || null, nextDirection, id);

  const item = db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
  res.json({ item });
});

api.delete("/categories/:id", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();

  db.prepare("UPDATE transactions SET category_id = NULL WHERE category_id = ?").run(id);
  db.prepare("DELETE FROM rules WHERE category_id = ?").run(id);
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);

  res.json({ ok: true });
});

api.get("/tags", (req, res) => {
  const db = getDb();
  const items = db.prepare("SELECT * FROM tags ORDER BY name_he ASC").all();
  res.json({ items });
});

api.post("/tags", express.json(), (req, res) => {
  const schema = z.object({
    name_he: z.string().min(1),
    icon: z.string().optional().nullable(),
    hide_from_transactions: z.union([z.boolean(), z.number().int()]).optional(),
    exclude_from_calculations: z.union([z.boolean(), z.number().int()]).optional(),
    use_for_forecast: z.union([z.boolean(), z.number().int()]).optional(),
  });
  const body = schema.parse(req.body);

  const db = getDb();
  const now = new Date().toISOString();
  const hideFromTransactions = normalizeFlag(body.hide_from_transactions);
  const excludeFromCalculations = normalizeFlag(body.exclude_from_calculations);
  const useForForecast = normalizeFlag(body.use_for_forecast);
  const row = db
    .prepare(
      `INSERT INTO tags(name_he, icon, hide_from_transactions, exclude_from_calculations, use_for_forecast, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(body.name_he.trim(), body.icon || null, hideFromTransactions, excludeFromCalculations, useForForecast, now);

  const item = db.prepare("SELECT * FROM tags WHERE id = ?").get(row.lastInsertRowid);
  res.json({ item });
});

api.patch("/tags/:id", express.json(), (req, res) => {
  const id = Number(req.params.id);
  const schema = z.object({
    name_he: z.string().min(1),
    icon: z.string().optional().nullable(),
    hide_from_transactions: z.union([z.boolean(), z.number().int()]).optional(),
    exclude_from_calculations: z.union([z.boolean(), z.number().int()]).optional(),
    use_for_forecast: z.union([z.boolean(), z.number().int()]).optional(),
  });
  const body = schema.parse(req.body);

  const db = getDb();
  const existing = db.prepare("SELECT * FROM tags WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "tag_not_found" });
    return;
  }
  const hideFromTransactions = normalizeFlag(
    body.hide_from_transactions,
    existing.hide_from_transactions
  );
  const excludeFromCalculations = normalizeFlag(
    body.exclude_from_calculations,
    existing.exclude_from_calculations
  );
  const useForForecast = normalizeFlag(
    body.use_for_forecast,
    existing.use_for_forecast
  );
  db.prepare(
    `UPDATE tags
     SET name_he = ?, icon = ?, hide_from_transactions = ?, exclude_from_calculations = ?, use_for_forecast = ?
     WHERE id = ?`
  ).run(body.name_he.trim(), body.icon || null, hideFromTransactions, excludeFromCalculations, useForForecast, id);

  const item = db.prepare("SELECT * FROM tags WHERE id = ?").get(id);
  if (Number(existing.exclude_from_calculations || 0) !== Number(excludeFromCalculations || 0)) {
    recalculateTransactionBalances(db);
  }
  res.json({ item });
});

api.delete("/tags/:id", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();

  const deletedTag = db.prepare("SELECT exclude_from_calculations FROM tags WHERE id = ?").get(id);
  db.prepare("DELETE FROM tags WHERE id = ?").run(id);
  if (deletedTag?.exclude_from_calculations) {
    recalculateTransactionBalances(db);
  }
  res.json({ ok: true });
});

api.get("/settings/opening-balance", (req, res) => {
  const db = getDb();
  const value = getSettingValue(db, "opening_balance");
  const parsed = value === null ? null : Number(value);
  const openingBalance = Number.isNaN(parsed) ? null : parsed;
  res.json({ openingBalance });
});

api.put("/settings/opening-balance", express.json(), (req, res) => {
  const schema = z.object({
    openingBalance: z.union([z.number(), z.string()]).nullable().optional(),
  });
  const body = schema.parse(req.body);
  const rawValue = body.openingBalance;
  const normalizedRaw =
    rawValue === null || rawValue === undefined ? "" : String(rawValue).trim();

  if (normalizedRaw === "") {
    const db = getDb();
    setSettingValue(db, "opening_balance", null);
    res.json({ openingBalance: null });
    return;
  }

  const parsed = Number(normalizedRaw.replace(/,/g, ""));
  if (Number.isNaN(parsed)) {
    res.status(400).json({ error: "invalid_opening_balance" });
    return;
  }

  const db = getDb();
  setSettingValue(db, "opening_balance", String(parsed));
  res.json({ openingBalance: parsed });
});

api.get("/settings/transactions-page-size", (req, res) => {
  const db = getDb();
  const value = getSettingValue(db, "transactions.pageSize.default");
  const normalized = value === null ? null : String(value);
  const pageSizeDefault = transactionPageSizeOptions.has(normalized) ? normalized : null;
  res.json({ pageSizeDefault });
});

api.put("/settings/transactions-page-size", express.json(), (req, res) => {
  const schema = z.object({
    pageSizeDefault: z.union([z.number(), z.string()]).nullable().optional(),
  });
  const body = schema.parse(req.body);
  const rawValue = body.pageSizeDefault;
  const normalizedRaw =
    rawValue === null || rawValue === undefined ? "" : String(rawValue).trim();

  if (normalizedRaw === "") {
    const db = getDb();
    setSettingValue(db, "transactions.pageSize.default", null);
    res.json({ pageSizeDefault: null });
    return;
  }

  if (!transactionPageSizeOptions.has(normalizedRaw)) {
    res.status(400).json({ error: "invalid_page_size_default" });
    return;
  }

  const db = getDb();
  setSettingValue(db, "transactions.pageSize.default", normalizedRaw);
  res.json({ pageSizeDefault: normalizedRaw });
});

api.get("/settings/dashboard-range", (req, res) => {
  const db = getDb();
  const value = getSettingValue(db, "dashboard.range.default");
  const normalized = value === null ? null : String(value);
  const rangePreset = dashboardRangeOptions.has(normalized) ? normalized : null;
  res.json({ rangePreset });
});

api.put("/settings/dashboard-range", express.json(), (req, res) => {
  const schema = z.object({
    rangePreset: z.union([z.number(), z.string()]).nullable().optional(),
  });
  const body = schema.parse(req.body);
  const rawValue = body.rangePreset;
  const normalizedRaw =
    rawValue === null || rawValue === undefined ? "" : String(rawValue).trim();

  if (normalizedRaw === "") {
    const db = getDb();
    setSettingValue(db, "dashboard.range.default", null);
    res.json({ rangePreset: null });
    return;
  }

  if (!dashboardRangeOptions.has(normalizedRaw)) {
    res.status(400).json({ error: "invalid_range_preset" });
    return;
  }

  const db = getDb();
  setSettingValue(db, "dashboard.range.default", normalizedRaw);
  res.json({ rangePreset: normalizedRaw });
});

api.get("/settings/transactions-coloring", (req, res) => {
  const db = getDb();
  const enabledRaw = getSettingValue(db, "transactions.coloring.enabled");
  const incomeRaw = getSettingValue(db, "transactions.coloring.incomeColor");
  const expenseRaw = getSettingValue(db, "transactions.coloring.expenseColor");
  const enabled = Boolean(parseBooleanSetting(enabledRaw, transactionColorDefaults.enabled));
  const incomeColor = resolveHexColor(incomeRaw, transactionColorDefaults.incomeColor);
  const expenseColor = resolveHexColor(expenseRaw, transactionColorDefaults.expenseColor);
  res.json({ enabled, incomeColor, expenseColor });
});

api.put("/settings/transactions-coloring", express.json(), (req, res) => {
  const schema = z.object({
    enabled: z.union([z.boolean(), z.number(), z.string()]).optional(),
    incomeColor: z.string().optional(),
    expenseColor: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const db = getDb();

  const currentEnabled = parseBooleanSetting(
    getSettingValue(db, "transactions.coloring.enabled"),
    transactionColorDefaults.enabled
  );
  const currentIncomeColor = resolveHexColor(
    getSettingValue(db, "transactions.coloring.incomeColor"),
    transactionColorDefaults.incomeColor
  );
  const currentExpenseColor = resolveHexColor(
    getSettingValue(db, "transactions.coloring.expenseColor"),
    transactionColorDefaults.expenseColor
  );

  const nextEnabled =
    body.enabled === undefined
      ? currentEnabled
      : parseBooleanSetting(body.enabled, transactionColorDefaults.enabled);
  const nextIncomeColor = body.incomeColor === undefined ? currentIncomeColor : body.incomeColor;
  const nextExpenseColor = body.expenseColor === undefined ? currentExpenseColor : body.expenseColor;

  if (!hexColorPattern.test(String(nextIncomeColor).trim())) {
    res.status(400).json({ error: "invalid_income_color" });
    return;
  }
  if (!hexColorPattern.test(String(nextExpenseColor).trim())) {
    res.status(400).json({ error: "invalid_expense_color" });
    return;
  }

  setSettingValue(db, "transactions.coloring.enabled", String(nextEnabled ? 1 : 0));
  setSettingValue(db, "transactions.coloring.incomeColor", String(nextIncomeColor).trim());
  setSettingValue(db, "transactions.coloring.expenseColor", String(nextExpenseColor).trim());
  res.json({
    enabled: Boolean(nextEnabled),
    incomeColor: String(nextIncomeColor).trim(),
    expenseColor: String(nextExpenseColor).trim(),
  });
});

api.get("/settings/rules-categories/export", (req, res) => {
  const db = getDb();
  const categories = db
    .prepare("SELECT * FROM categories ORDER BY id ASC")
    .all()
    .map((category) => ({
      ...category,
      direction: category.direction || "expense",
    }));
  const tags = db.prepare("SELECT * FROM tags ORDER BY id ASC").all();
  const rules = db
    .prepare("SELECT * FROM rules ORDER BY id ASC")
    .all()
    .map(({ applied_count, ...rule }) => ({
      ...rule,
      tag_ids: parseTagIds(rule.tag_ids),
    }));
  const payload = {
    exported_at: new Date().toISOString(),
    categories,
    tags,
    rules,
  };

  const fileName = `rules_categories_${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(JSON.stringify(payload, null, 2));
});

api.post("/settings/rules-categories/import", express.json(), (req, res) => {
  const schema = z.object({
    categories: z.array(categorySchema),
    tags: z.array(tagSchema),
    rules: z.array(ruleSchema),
  });
  const body = schema.parse(req.body);
  const db = getDb();

  const categoryIds = new Set(body.categories.map((category) => category.id));
  const tagIds = new Set(body.tags.map((tag) => tag.id));
  const invalidRule = body.rules.find((rule) => {
    if (!rule.category_id && (!rule.tag_ids || rule.tag_ids.length === 0)) {
      return true;
    }
    if (rule.category_id && !categoryIds.has(rule.category_id)) {
      return true;
    }
    if (rule.tag_ids && rule.tag_ids.some((tagId) => !tagIds.has(tagId))) {
      return true;
    }
    return false;
  });
  if (invalidRule) {
    res.status(400).json({ error: "invalid_rule_reference" });
    return;
  }

  const now = new Date().toISOString();
  const insertCategory = db.prepare(
    "INSERT INTO categories(id, name_he, icon, direction, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const insertTag = db.prepare(
    `INSERT INTO tags(
      id, name_he, icon, hide_from_transactions, exclude_from_calculations, use_for_forecast, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertRule = db.prepare(
    `
      INSERT INTO rules(
        id, name, enabled, match_field, match_type, pattern, source, direction, category_id, tag_ids, amount_min, amount_max, run_on_categorized, applied_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  );

  const tx = db.transaction(() => {
    db.prepare("UPDATE transactions SET category_id = NULL").run();
    db.prepare("DELETE FROM rules").run();
    db.prepare("DELETE FROM categories").run();
    db.prepare("DELETE FROM tags").run();

    for (const category of body.categories) {
      const directionValue = category.direction || category.type || "expense";
      insertCategory.run(
        category.id,
        category.name_he.trim(),
        category.icon || null,
        directionValue,
        category.created_at || now
      );
    }

    for (const tag of body.tags) {
      insertTag.run(
        tag.id,
        tag.name_he.trim(),
        tag.icon || null,
        normalizeFlag(tag.hide_from_transactions),
        normalizeFlag(tag.exclude_from_calculations),
        normalizeFlag(tag.use_for_forecast),
        tag.created_at || now
      );
    }

    for (const rule of body.rules) {
      const enabledValue =
        typeof rule.enabled === "number" ? (rule.enabled ? 1 : 0) : rule.enabled === false ? 0 : 1;
      insertRule.run(
        rule.id,
        rule.name.trim(),
        enabledValue,
        rule.match_field,
        rule.match_type,
        rule.pattern,
        rule.source || null,
        rule.direction || null,
        rule.category_id || null,
        rule.tag_ids && rule.tag_ids.length ? JSON.stringify(rule.tag_ids) : null,
        rule.amount_min ?? null,
        rule.amount_max ?? null,
        normalizeFlag(rule.run_on_categorized),
        0,
        rule.created_at || now
      );
    }
  });

  tx();
  recalculateTransactionBalances(db);
  res.json({ ok: true });
});

api.post("/settings/clear-categories", (req, res) => {
  const db = getDb();
  const result = db.prepare("UPDATE transactions SET category_id = NULL").run();
  db.prepare("UPDATE rules SET applied_count = 0").run();
  res.json({ ok: true, cleared: result.changes || 0 });
});

api.post("/settings/clear-tags", (req, res) => {
  const db = getDb();
  const result = db.prepare("UPDATE transactions SET tags = NULL").run();
  db.prepare("UPDATE rules SET applied_count = 0").run();
  recalculateTransactionBalances(db);
  res.json({ ok: true, cleared: result.changes || 0 });
});

api.post("/settings/backup", express.json(), async (req, res) => {
  const schema = z.object({ destination: z.string().min(1) });
  const body = schema.parse(req.body);
  const destinationRoot = path.resolve(body.destination);
  const dbDir = path.resolve(path.dirname(config.dbPath));

  const destStat = await fs.stat(destinationRoot).catch(() => null);
  if (!destStat || !destStat.isDirectory()) {
    res.status(400).json({ error: "invalid_destination" });
    return;
  }

  const dbStat = await fs.stat(dbDir).catch(() => null);
  if (!dbStat || !dbStat.isDirectory()) {
    res.status(400).json({ error: "db_missing" });
    return;
  }

  const folderName = buildBackupFolderName(new Date());
  const destination = path.join(destinationRoot, folderName);

  await copyDir(dbDir, destination);
  res.json({ ok: true, destination, folder_name: folderName });
});

api.post("/settings/restore", express.json(), async (req, res) => {
  const schema = z.object({ source: z.string().min(1) });
  const body = schema.parse(req.body);
  const sourceDir = path.resolve(body.source);
  const dbDir = path.resolve(path.dirname(config.dbPath));

  if (sourceDir === dbDir) {
    res.status(400).json({ error: "invalid_source" });
    return;
  }

  const sourceStat = await fs.stat(sourceDir).catch(() => null);
  if (!sourceStat || !sourceStat.isDirectory()) {
    res.status(400).json({ error: "invalid_source" });
    return;
  }

  closeDb();
  await fs.rm(dbDir, { recursive: true, force: true });
  await fs.mkdir(dbDir, { recursive: true });
  await copyDir(sourceDir, dbDir);
  res.json({ ok: true });
});

api.post("/settings/reset", async (req, res) => {
  try {
    closeDb();
    await fs.rm(config.dataDir, { recursive: true, force: true });
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.mkdir(config.inboxDir, { recursive: true });
    await fs.mkdir(config.processedDir, { recursive: true });
    migrateDb();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "reset_failed" });
  }
});

api.get("/rules", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT r.*, c.name_he AS category_name
        FROM rules r
        LEFT JOIN categories c ON c.id = r.category_id
        ORDER BY r.id DESC
      `
    )
    .all();
  const items = rows.map((row) => ({
    ...row,
    tag_ids: parseTagIds(row.tag_ids),
  }));
  res.json({ items });
});

api.post("/rules", express.json(), (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    match_field: z.enum(["merchant", "description", "category_raw"]),
    match_type: z.enum(["contains", "regex", "equals"]),
    pattern: z.string().min(1),
    source: z.string().optional().nullable(),
    direction: z.enum(["expense", "income"]).optional().nullable(),
    category_id: z.number().int().nullable().optional(),
    tag_ids: z.array(z.number().int()).optional(),
    amount_min: z.number().optional().nullable(),
    amount_max: z.number().optional().nullable(),
    run_on_categorized: z.boolean().optional(),
  });

  const body = schema.parse(req.body);
  const db = getDb();
  const now = new Date().toISOString();

  if (
    typeof body.amount_min === "number" &&
    typeof body.amount_max === "number" &&
    body.amount_min > body.amount_max
  ) {
    res.status(400).json({ error: "invalid_amount_range" });
    return;
  }

  const categoryId = body.category_id ?? null;
  const tagIds = body.tag_ids || [];
  if (!categoryId && tagIds.length === 0) {
    res.status(400).json({ error: "rule_requires_category_or_tags" });
    return;
  }
  if (categoryId) {
    const category = db.prepare("SELECT id FROM categories WHERE id = ?").get(categoryId);
    if (!category) {
      res.status(400).json({ error: "category_id not found" });
      return;
    }
  }
  if (tagIds.length > 0) {
    const existingTags = db
      .prepare(`SELECT id FROM tags WHERE id IN (${tagIds.map(() => "?").join(", ")})`)
      .all(...tagIds);
    if (existingTags.length !== tagIds.length) {
      res.status(400).json({ error: "tag_ids_not_found" });
      return;
    }
  }

  const row = db
    .prepare(
      `
        INSERT INTO rules(
          name, enabled, match_field, match_type, pattern, source, direction, category_id, tag_ids, amount_min, amount_max, run_on_categorized, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      body.name.trim(),
      body.enabled === false ? 0 : 1,
      body.match_field,
      body.match_type,
      body.pattern,
      body.source || null,
      body.direction || null,
      categoryId,
      tagIds.length ? JSON.stringify(tagIds) : null,
      body.amount_min ?? null,
      body.amount_max ?? null,
      body.run_on_categorized ? 1 : 0,
      now
    );

  const item = db.prepare("SELECT * FROM rules WHERE id = ?").get(row.lastInsertRowid);
  res.json({ item: { ...item, tag_ids: parseTagIds(item.tag_ids) } });
});

api.patch("/rules/:id", express.json(), (req, res) => {
  const id = Number(req.params.id);
  const schema = z.object({ 
    enabled: z.boolean().optional(),
    name: z.string().min(1).optional(),
    match_field: z.enum(["merchant", "description", "category_raw"]).optional(),
    match_type: z.enum(["contains", "regex", "equals"]).optional(),
    pattern: z.string().min(1).optional(),
    source: z.string().optional().nullable(),
    direction: z.enum(["expense", "income"]).optional().nullable(),
    category_id: z.number().int().nullable().optional(),
    tag_ids: z.array(z.number().int()).optional(),
    amount_min: z.number().optional().nullable(),
    amount_max: z.number().optional().nullable(),
    run_on_categorized: z.boolean().optional(),
  });
  const body = schema.parse(req.body);
  const db = getDb();

  const current = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  if (!current) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const nextCategoryId = Object.prototype.hasOwnProperty.call(body, "category_id")
    ? body.category_id
    : current.category_id;
  const nextTagIds = Object.prototype.hasOwnProperty.call(body, "tag_ids")
    ? body.tag_ids || []
    : parseTagIds(current.tag_ids);
  if (!nextCategoryId && nextTagIds.length === 0) {
    res.status(400).json({ error: "rule_requires_category_or_tags" });
    return;
  }
  const nextAmountMin = Object.prototype.hasOwnProperty.call(body, "amount_min")
    ? body.amount_min
    : current.amount_min;
  const nextAmountMax = Object.prototype.hasOwnProperty.call(body, "amount_max")
    ? body.amount_max
    : current.amount_max;
  if (
    typeof nextAmountMin === "number" &&
    typeof nextAmountMax === "number" &&
    nextAmountMin > nextAmountMax
  ) {
    res.status(400).json({ error: "invalid_amount_range" });
    return;
  }
  if (nextCategoryId) {
    const category = db.prepare("SELECT id FROM categories WHERE id = ?").get(nextCategoryId);
    if (!category) {
      res.status(400).json({ error: "category_id not found" });
      return;
    }
  }
  if (nextTagIds.length > 0) {
    const existingTags = db
      .prepare(`SELECT id FROM tags WHERE id IN (${nextTagIds.map(() => "?").join(", ")})`)
      .all(...nextTagIds);
    if (existingTags.length !== nextTagIds.length) {
      res.status(400).json({ error: "tag_ids_not_found" });
      return;
    }
  }

  // Build dynamic update query based on provided fields
  const updates = [];
  const params = [];

  if (typeof body.enabled === "boolean") {
    updates.push("enabled = ?");
    params.push(body.enabled ? 1 : 0);
  }
  if (body.name) {
    updates.push("name = ?");
    params.push(body.name.trim());
  }
  if (body.match_field) {
    updates.push("match_field = ?");
    params.push(body.match_field);
  }
  if (body.match_type) {
    updates.push("match_type = ?");
    params.push(body.match_type);
  }
  if (body.pattern) {
    updates.push("pattern = ?");
    params.push(body.pattern);
  }
  if (body.source !== undefined) {
    updates.push("source = ?");
    params.push(body.source || null);
  }
  if (body.direction !== undefined) {
    updates.push("direction = ?");
    params.push(body.direction || null);
  }
  if (Object.prototype.hasOwnProperty.call(body, "category_id")) {
    updates.push("category_id = ?");
    params.push(body.category_id || null);
  }
  if (Object.prototype.hasOwnProperty.call(body, "tag_ids")) {
    updates.push("tag_ids = ?");
    params.push(body.tag_ids && body.tag_ids.length > 0 ? JSON.stringify(body.tag_ids) : null);
  }
  if (Object.prototype.hasOwnProperty.call(body, "amount_min")) {
    updates.push("amount_min = ?");
    params.push(body.amount_min ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(body, "amount_max")) {
    updates.push("amount_max = ?");
    params.push(body.amount_max ?? null);
  }
  if (typeof body.run_on_categorized === "boolean") {
    updates.push("run_on_categorized = ?");
    params.push(body.run_on_categorized ? 1 : 0);
  }

  if (updates.length > 0) {
    params.push(id);
    const sql = `UPDATE rules SET ${updates.join(", ")} WHERE id = ?`;
    db.prepare(sql).run(...params);
  }

  const item = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  res.json({ item: { ...item, tag_ids: parseTagIds(item.tag_ids) } });
});

api.delete("/rules/:id", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  db.prepare("DELETE FROM rules WHERE id = ?").run(id);
  res.json({ ok: true });
});

api.post("/rules/apply", express.json(), (req, res) => {
  const db = getDb();
  const scope = req.body?.scope || "uncategorized";
  const clearExistingTags = Boolean(req.body?.clear_existing_tags);
  const beforeUncategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NULL")
    .get().count;
  const beforeCategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NOT NULL")
    .get().count;
  const ids = db
    .prepare(
      "SELECT id, category_id, tags, merchant, description, category_raw, source, direction, amount_signed FROM transactions"
    )
    .all();
  const rules = db
    .prepare("SELECT * FROM rules ORDER BY run_on_categorized ASC, id ASC")
    .all();

  let updated = 0;
  const tx = db.transaction(() => {
    if (scope === "cancel_categorized") {
      for (const row of ids) {
        if (!row.category_id && !row.tags) continue;
        const { ruleCategoryIds, ruleTagIds } = getRuleMatchEffects(row, rules, { ignoreCategoryCheck: true });
        if (ruleCategoryIds.length === 0 && ruleTagIds.length === 0) continue;

        const currentCategoryId = row.category_id ? Number(row.category_id) : null;
        const shouldClearCategory =
          currentCategoryId != null && ruleCategoryIds.includes(currentCategoryId);

        const currentTagIds = parseTagIds(row.tags);
        const ruleTagSet = new Set(ruleTagIds);
        const nextTagIds = currentTagIds.filter((tagId) => !ruleTagSet.has(tagId));
        const tagsChanged = currentTagIds.length !== nextTagIds.length;

        if (!shouldClearCategory && !tagsChanged) continue;

        const nextCategoryId = shouldClearCategory ? null : currentCategoryId;
        const nextTagsValue = nextTagIds.length > 0 ? JSON.stringify(nextTagIds) : null;
        db.prepare("UPDATE transactions SET category_id = ?, tags = ? WHERE id = ?").run(
          nextCategoryId,
          nextTagsValue,
          row.id
        );
        updated++;
      }
      return;
    }

    for (const row of ids) {
      if (scope === "uncategorized" && row.category_id) continue;
      if (scope === "categorized" && !row.category_id) continue;
      const forceRunOnCategorized = scope === "categorized" || scope === "all";
      if (applyRulesToTransaction(db, row.id, { forceRunOnCategorized, clearExistingTags })) updated++;
    }
  });

  tx();
  recalculateTransactionBalances(db);
  const afterUncategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NULL")
    .get().count;
  const afterCategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NOT NULL")
    .get().count;
  const updatedUncategorized = Math.max(0, beforeUncategorized - afterUncategorized);
  const updatedCategorized = Math.max(0, beforeCategorized - afterCategorized);
  res.json({
    updated: scope === "all" ? updated : scope === "categorized" ? updatedCategorized : updatedUncategorized,
    scanned: ids.length,
    updated_total: updated,
    uncategorized_before: beforeUncategorized,
    uncategorized_after: afterUncategorized,
    categorized_before: beforeCategorized,
    categorized_after: afterCategorized,
    cleared: scope === "cancel_categorized" ? updated : 0,
  });
});

api.post("/rules/:id/apply", express.json(), (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const scope = req.body?.scope || "uncategorized";
  const clearExistingTags = Boolean(req.body?.clear_existing_tags);
  const rule = db
    .prepare(
      "SELECT r.*, c.name_he AS category_name FROM rules r LEFT JOIN categories c ON c.id = r.category_id WHERE r.id = ?"
    )
    .get(id);
  if (!rule) {
    res.status(404).json({ error: "rule_not_found" });
    return;
  }

  const beforeUncategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NULL")
    .get().count;
  const beforeCategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NOT NULL")
    .get().count;
  const rows = db
    .prepare("SELECT id, category_id, tags, merchant, description, category_raw, source, direction, amount_signed FROM transactions")
    .all();

  let updated = 0;
  const tx = db.transaction(() => {
    if (scope === "cancel_categorized") {
      for (const row of rows) {
        if (!row.category_id && !row.tags) continue;
        const { ruleCategoryIds, ruleTagIds } = getRuleMatchEffects(row, [rule], { ignoreCategoryCheck: true });
        if (ruleCategoryIds.length === 0 && ruleTagIds.length === 0) continue;

        const currentCategoryId = row.category_id ? Number(row.category_id) : null;
        const shouldClearCategory =
          currentCategoryId != null && ruleCategoryIds.includes(currentCategoryId);
        const currentTagIds = parseTagIds(row.tags);
        const ruleTagSet = new Set(ruleTagIds);
        const nextTagIds = currentTagIds.filter((tagId) => !ruleTagSet.has(tagId));
        const tagsChanged = currentTagIds.length !== nextTagIds.length;

        if (!shouldClearCategory && !tagsChanged) continue;

        const nextCategoryId = shouldClearCategory ? null : currentCategoryId;
        const nextTagsValue = nextTagIds.length > 0 ? JSON.stringify(nextTagIds) : null;
        db.prepare("UPDATE transactions SET category_id = ?, tags = ? WHERE id = ?").run(
          nextCategoryId,
          nextTagsValue,
          row.id
        );
        updated++;
      }
      return;
    }

    for (const row of rows) {
      if (scope === "uncategorized" && row.category_id) continue;
      if (scope === "categorized" && !row.category_id) continue;
      const effectiveRule = scope === "categorized" || scope === "all"
        ? { ...rule, run_on_categorized: 1, clear_existing_tags: clearExistingTags }
        : { ...rule, clear_existing_tags: clearExistingTags };
      if (applySingleRuleToTransaction(db, row.id, effectiveRule)) updated++;
    }
  });

  tx();
  recalculateTransactionBalances(db);
  const afterUncategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NULL")
    .get().count;
  const afterCategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NOT NULL")
    .get().count;
  const updatedUncategorized = Math.max(0, beforeUncategorized - afterUncategorized);
  const updatedCategorized = Math.max(0, beforeCategorized - afterCategorized);
  res.json({
    updated: scope === "all" ? updated : scope === "categorized" ? updatedCategorized : updatedUncategorized,
    scanned: rows.length,
    updated_total: updated,
    uncategorized_before: beforeUncategorized,
    uncategorized_after: afterUncategorized,
    categorized_before: beforeCategorized,
    categorized_after: afterCategorized,
    cleared: scope === "cancel_categorized" ? updated : 0,
  });
});

function buildTxnWhere({
  from,
  to,
  q,
  categoryId,
  tagIds,
  source,
  direction,
  min,
  max,
  monthDays,
  untagged,
  uncategorized,
  excludeTagIds,
  tableAlias = "t",
}) {
  const where = [];
  const params = {};
  const columnPrefix = tableAlias ? `${tableAlias}.` : "";

  if (from) {
    where.push(`${columnPrefix}txn_date >= @from`);
    params.from = String(from);
  }
  if (to) {
    where.push(`${columnPrefix}txn_date <= @to`);
    params.to = String(to);
  }
  if (source === CREDIT_CARD_SOURCES_FILTER) {
    where.push(`${columnPrefix}source IS NOT NULL AND ${columnPrefix}source <> @bankSource`);
    params.bankSource = "bank";
  } else if (source) {
    where.push(`${columnPrefix}source = @source`);
    params.source = String(source);
  }
  if (direction) {
    where.push(`${columnPrefix}direction = @direction`);
    params.direction = String(direction);
  }

  if (categoryId) {
    where.push(`${columnPrefix}category_id = @categoryId`);
    params.categoryId = Number(categoryId);
  }
  const tagFilters = [];
  if (tagIds && tagIds.length > 0) {
    const tagConditions = tagIds.map((tagId, index) => {
      const key = `tagId_${index}`;
      params[key] = tagId;
      return `EXISTS (SELECT 1 FROM json_each(${columnPrefix}tags) WHERE value = @${key})`;
    });
    tagFilters.push(tagConditions.join(" AND "));
  }
  if (untagged === "1") {
    tagFilters.push(
      `(${columnPrefix}tags IS NULL OR json_array_length(${columnPrefix}tags) = 0)`
    );
  }
  if (tagFilters.length > 0) {
    where.push(`(${tagFilters.join(" OR ")})`);
  }
  if (uncategorized === "1") {
    where.push(`${columnPrefix}category_id IS NULL`);
  }

  if (q) {
    where.push(
      `(${columnPrefix}merchant LIKE @like OR ${columnPrefix}description LIKE @like OR ${columnPrefix}category_raw LIKE @like OR CAST(${columnPrefix}amount_signed AS TEXT) LIKE @like OR CAST(ABS(${columnPrefix}amount_signed) AS TEXT) LIKE @like)`
    );
    params.like = `%${String(q)}%`;
  }

  if (min !== undefined && min !== null && String(min) !== "") {
    where.push(`${columnPrefix}amount_signed >= @min`);
    params.min = Number(min);
  }
  if (max !== undefined && max !== null && String(max) !== "") {
    where.push(`${columnPrefix}amount_signed <= @max`);
    params.max = Number(max);
  }
  const parsedMonthDays = parseMonthDays(monthDays);
  if (String(monthDays || "").trim() !== "") {
    if (parsedMonthDays.length === 0) {
      where.push("1 = 0");
    } else {
      const placeholders = parsedMonthDays
        .map((day, index) => {
          const key = `monthDay_${index}`;
          params[key] = day;
          return `@${key}`;
        })
        .join(", ");
      where.push(`CAST(strftime('%d', ${columnPrefix}txn_date) AS INTEGER) IN (${placeholders})`);
    }
  }

  if (excludeTagIds && excludeTagIds.length > 0) {
    const placeholders = excludeTagIds
      .map((tagId, index) => {
        const key = `excludeTagId_${index}`;
        params[key] = tagId;
        return `@${key}`;
      })
      .join(", ");
    where.push(
      `NOT EXISTS (SELECT 1 FROM json_each(${columnPrefix}tags) WHERE value IN (${placeholders}))`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, params };
}

function getExcludedTagIds(db) {
  return db
    .prepare("SELECT id FROM tags WHERE exclude_from_calculations = 1")
    .all()
    .map((row) => row.id);
}

function parseMonthDays(value) {
  const days = [];
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const rangeMatch = item.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        if (start >= 1 && start <= 31 && end >= 1 && end <= 31 && start <= end) {
          for (let day = start; day <= end; day += 1) days.push(day);
        }
        return;
      }

      const day = Number(item);
      if (Number.isInteger(day) && day >= 1 && day <= 31) days.push(day);
    });
  return Array.from(new Set(days));
}
function parseReportIds(value) {
  return String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
}

function addReportIdFilter({ where, params, ids, column, prefix }) {
  if (!ids.length) return
  const placeholders = ids.map((id, index) => {
    const key = prefix + "_" + index
    params[key] = id
    return "@" + key
  })
  where.push(column + " IN (" + placeholders.join(", ") + ")")
}

function buildReportWhere({
  from,
  to,
  source,
  direction,
  categoryIds,
  tagIds,
  excludeTagIds,
}) {
  const where = []
  const params = {}

  if (from) {
    where.push("t.txn_date >= @from")
    params.from = String(from)
  }
  if (to) {
    where.push("t.txn_date <= @to")
    params.to = String(to)
  }
  if (source) {
    where.push("t.source = @source")
    params.source = String(source)
  }
  if (direction) {
    where.push("t.direction = @direction")
    params.direction = direction
  }
  addReportIdFilter({
    where,
    params,
    ids: categoryIds,
    column: "t.category_id",
    prefix: "categoryId"
  })
  if (tagIds.length > 0) {
    const placeholders = tagIds.map((tagId, index) => {
      const key = "tagId_" + index
      params[key] = tagId
      return "@" + key
    })
    where.push("EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value IN (" + placeholders.join(", ") + "))")
  }
  if (excludeTagIds.length > 0) {
    const placeholders = excludeTagIds.map((tagId, index) => {
      const key = "excludeReportTagId_" + index
      params[key] = tagId
      return "@" + key
    })
    where.push("NOT EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value IN (" + placeholders.join(", ") + "))")
  }

  return { where, params }
}

function getReportGroup({ breakdown, series, tagIds, categoryIds, includeExcludedFromCalculations }) {
  const joins = []
  let groupExpr = "COALESCE(c.id, @uncategorizedKey)"
  let labelExpr = "COALESCE(c.icon, @emptyLabel) || CASE WHEN c.icon IS NULL OR c.icon = @emptyLabel THEN @emptyLabel ELSE @spaceLabel END || COALESCE(c.name_he, @uncategorizedLabel)"
  let filterType = "category"
  let filterValueExpr = "c.id"
  let groupBy = "group_key, label, filter_type, filter_value"
  let seriesExpr = "NULL"
  let seriesLabelExpr = "NULL"

  if (breakdown === "tag" || series === "tag") {
    joins.push("LEFT JOIN json_each(t.tags) AS report_tag_link")
    joins.push("LEFT JOIN tags AS report_tags ON report_tags.id = report_tag_link.value")
  }
  if (breakdown === "category" || series === "category") {
    joins.push("LEFT JOIN categories c ON c.id = t.category_id")
  }

  if (breakdown === "tag") {
    groupExpr = "COALESCE(report_tags.id, @untaggedKey)"
    labelExpr = "COALESCE(report_tags.icon, @emptyLabel) || CASE WHEN report_tags.icon IS NULL OR report_tags.icon = @emptyLabel THEN @emptyLabel ELSE @spaceLabel END || COALESCE(report_tags.name_he, @untaggedLabel)"
    filterType = "tag"
    filterValueExpr = "report_tags.id"
  } else if (breakdown === "month") {
    groupExpr = "strftime(@monthKeyFormat, t.txn_date)"
    labelExpr = "strftime(@monthLabelFormat, t.txn_date)"
    filterType = "month"
    filterValueExpr = "strftime(@monthKeyFormat, t.txn_date)"
  }

  if (series === "tag") {
    seriesExpr = "COALESCE(report_tags.id, @untaggedKey)"
    seriesLabelExpr = "COALESCE(report_tags.icon, @emptyLabel) || CASE WHEN report_tags.icon IS NULL OR report_tags.icon = @emptyLabel THEN @emptyLabel ELSE @spaceLabel END || COALESCE(report_tags.name_he, @untaggedLabel)"
    groupBy += ", series_key, series_label"
  } else if (series === "category") {
    seriesExpr = "COALESCE(c.id, @uncategorizedKey)"
    seriesLabelExpr = "COALESCE(c.icon, @emptyLabel) || CASE WHEN c.icon IS NULL OR c.icon = @emptyLabel THEN @emptyLabel ELSE @spaceLabel END || COALESCE(c.name_he, @uncategorizedLabel)"
    groupBy += ", series_key, series_label"
  }

  const extraWhere = []
  if (breakdown === "tag" && tagIds.length > 0) {
    extraWhere.push("report_tags.id IN (" + tagIds.map((_, index) => "@tagId_" + index).join(", ") + ")")
  }
  if (breakdown === "category" && categoryIds.length > 0) {
    extraWhere.push("c.id IN (" + categoryIds.map((_, index) => "@categoryId_" + index).join(", ") + ")")
  }
  if ((breakdown === "tag" || series === "tag") && !includeExcludedFromCalculations) {
    extraWhere.push("(report_tags.id IS NULL OR report_tags.exclude_from_calculations = 0)")
  }

  return {
    joins: Array.from(new Set(joins)).join("\n"),
    groupExpr,
    labelExpr,
    filterType,
    filterValueExpr,
    seriesExpr,
    seriesLabelExpr,
    groupBy,
    extraWhere
  }
}

function buildReportDatasets(rows, measure) {
  const labels = Array.from(new Set(rows.map((row) => row.label)))

  if (rows.some((row) => row.seriesLabel)) {
    const seriesLabels = Array.from(new Set(rows.map((row) => row.seriesLabel).filter(Boolean)))
    const datasets = seriesLabels.map((seriesLabel) => ({
      label: seriesLabel,
      data: labels.map((label) => {
        const row = rows.find((item) => item.label === label && item.seriesLabel === seriesLabel)
        return Number(row?.total || 0)
      })
    }))
    return { labels, datasets }
  }

  if (measure === "income_expense") {
    return {
      labels,
      datasets: [
        { label: "הכנסות", data: rows.map((row) => Number(row.income || 0)) },
        { label: "הוצאות", data: rows.map((row) => Number(row.expenses || 0)) }
      ]
    }
  }

  const datasetLabel = measure === "income" ? "הכנסות" : measure === "net" ? "נטו" : "הוצאות"
  return {
    labels,
    datasets: [{ label: datasetLabel, data: rows.map((row) => Number(row.total || 0)) }]
  }
}

api.get("/reports/preview", (req, res) => {
  try {
    const schema = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      source: z.string().optional(),
      measure: z.enum(["expense", "income", "net", "income_expense"]).default("expense"),
      breakdown: z.enum(["category", "tag", "month"]).default("category"),
      series: z.enum(["none", "category", "tag"]).default("none"),
      categoryIds: z.string().optional(),
      tagIds: z.string().optional(),
      includeExcludedFromCalculations: z.string().optional()
    })
    const query = schema.parse(req.query)
    const db = getDb()
    const categoryIds = parseReportIds(query.categoryIds)
    const tagIds = parseReportIds(query.tagIds)
    const includeExcludedFromCalculations = query.includeExcludedFromCalculations === "1" || query.includeExcludedFromCalculations === "true"
    const direction = query.measure === "expense" || query.measure === "income" ? query.measure : null
    const excludeTagIds = includeExcludedFromCalculations ? [] : getExcludedTagIds(db)
    const base = buildReportWhere({
      from: query.from,
      to: query.to,
      source: query.source,
      direction,
      categoryIds,
      tagIds,
      excludeTagIds
    })
    const group = getReportGroup({
      breakdown: query.breakdown,
      series: query.series,
      tagIds,
      categoryIds,
      includeExcludedFromCalculations
    })
    const whereParts = [...base.where, ...group.extraWhere]
    const whereSql = whereParts.length ? "WHERE " + whereParts.join(" AND ") : ""
    const params = {
      ...base.params,
      emptyLabel: "",
      spaceLabel: " ",
      uncategorizedLabel: "לא מסווג",
      untaggedLabel: "ללא תג",
      uncategorizedKey: "uncategorized",
      untaggedKey: "untagged",
      filterType: group.filterType,
      monthKeyFormat: "%Y-%m",
      monthLabelFormat: "%m/%Y",
      expenseDirection: "expense",
      incomeDirection: "income"
    }
    const rows = db.prepare(
      "SELECT " +
        group.groupExpr + " AS group_key, " +
        group.labelExpr + " AS label, " +
        "@filterType AS filter_type, " +
        group.filterValueExpr + " AS filter_value, " +
        group.seriesExpr + " AS series_key, " +
        group.seriesLabelExpr + " AS series_label, " +
        "SUM(CASE WHEN t.direction = @incomeDirection THEN t.amount_signed ELSE 0 END) AS income, " +
        "ABS(SUM(CASE WHEN t.direction = @expenseDirection THEN t.amount_signed ELSE 0 END)) AS expenses, " +
        "SUM(t.amount_signed) AS net, " +
        "COUNT(DISTINCT t.id) AS count " +
      "FROM transactions t " +
        group.joins + " " +
        whereSql + " " +
      "GROUP BY " + group.groupBy + " " +
      "ORDER BY group_key ASC " +
      "LIMIT 500"
    ).all(params)
    const normalizedRows = rows.map((row) => {
      const total = query.measure === "income"
        ? Number(row.income || 0)
        : query.measure === "net" || query.measure === "income_expense"
          ? Number(row.net || 0)
          : Number(row.expenses || 0)
      return {
        label: row.label,
        filterType: row.filter_type,
        filterValue: row.filter_value,
        seriesLabel: row.series_label,
        income: Number(row.income || 0),
        expenses: Number(row.expenses || 0),
        net: Number(row.net || 0),
        count: Number(row.count || 0),
        total
      }
    })
    const chart = buildReportDatasets(normalizedRows, query.measure)
    res.json({ labels: chart.labels, datasets: chart.datasets, rows: normalizedRows })
  } catch (error) {
    res.status(400).json({ error: "invalid_report" })
  }
})
api.get("/transactions", (req, res) => {
  const db = getDb();

  const {
    from,
    to,
    q,
    categoryId,
    tagIds,
    excludedTagIds: queryExcludedTagIds,
    source,
    direction,
    min,
    max,
    monthDays,
    untagged,
    uncategorized,
    includeExcludedFromCalculations,
    sort = "chronological_index_desc",
    page = "1",
    pageSize = "50",
  } = req.query;

  const parsedTagIds = String(tagIds || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  const parsedExcludedTagIds = parseReportIds(queryExcludedTagIds);

  const { whereSql, params: baseParams } = buildTxnWhere({
    from,
    to,
    q,
    categoryId,
    tagIds: parsedTagIds,
    source,
    direction,
    min,
    max,
    monthDays,
    untagged,
    uncategorized,
    excludeTagIds: parsedExcludedTagIds,
  });

  const shouldIncludeExcluded =
    includeExcludedFromCalculations === "1" || includeExcludedFromCalculations === "true";
  const excludedTagIds = shouldIncludeExcluded
    ? parsedExcludedTagIds
    : Array.from(new Set([...getExcludedTagIds(db), ...parsedExcludedTagIds]));
  const { whereSql: totalsWhereSql, params: totalsParams } = buildTxnWhere({
    from,
    to,
    q,
    categoryId,
    tagIds: parsedTagIds,
    source,
    direction,
    min,
    max,
    monthDays,
    untagged,
    uncategorized,
    excludeTagIds: excludedTagIds,
  });

  const pageNum = Math.max(1, Number(page) || 1);
  const pageSizeNum = Math.min(1000, Math.max(1, Number(pageSize) || 50));
  const offset = (pageNum - 1) * pageSizeNum;
  const effectiveTxnDate =
    "CASE WHEN t.posting_date IS NOT NULL AND t.txn_date IS NOT NULL AND (julianday(t.posting_date) - julianday(t.txn_date)) > 31 THEN t.posting_date ELSE COALESCE(t.txn_date, t.posting_date) END";

  const orderBy = (() => {
    switch (sort) {
      case "txn_date_asc":
        return `${effectiveTxnDate} ASC, CASE WHEN t.source LIKE 'כ.אשראי%' THEN 1 ELSE 0 END ASC, COALESCE(t.intra_day_index, t.source_row, t.id) ASC, t.id ASC`;
      case "txn_date_desc":
        return `${effectiveTxnDate} DESC, CASE WHEN t.source LIKE 'כ.אשראי%' THEN 1 ELSE 0 END ASC, COALESCE(t.intra_day_index, t.source_row, t.id) ASC, t.id ASC`;
      case "amount_desc":
        return "t.amount_signed DESC, t.id DESC";
      case "amount_asc":
        return "t.amount_signed ASC, t.id ASC";
      case "description_asc":
        return "COALESCE(t.merchant, t.description, '') ASC, t.id ASC";
      case "description_desc":
        return "COALESCE(t.merchant, t.description, '') DESC, t.id DESC";
      case "tags_asc":
        return "COALESCE(t.tags, '') ASC, t.id ASC";
      case "tags_desc":
        return "COALESCE(t.tags, '') DESC, t.id DESC";
      case "category_asc":
        return "COALESCE(c.name_he, '') ASC, t.id ASC";
      case "category_desc":
        return "COALESCE(c.name_he, '') DESC, t.id DESC";
      case "source_asc":
        return "COALESCE(t.source, '') ASC, t.id ASC";
      case "source_desc":
        return "COALESCE(t.source, '') DESC, t.id DESC";
      case "real_balance_asc":
        return "t.real_balance_after IS NULL, t.real_balance_after ASC, t.id ASC";
      case "real_balance_desc":
        return "t.real_balance_after IS NULL, t.real_balance_after DESC, t.id DESC";
      case "affected_balance_asc":
      case "balance_asc":
        return "t.affected_balance_after IS NULL, t.affected_balance_after ASC, t.id ASC";
      case "affected_balance_desc":
      case "balance_desc":
        return "t.affected_balance_after IS NULL, t.affected_balance_after DESC, t.id DESC";
      case "chronological_index_asc":
        return "t.chronological_index IS NULL, t.chronological_index ASC, t.id ASC";
      case "chronological_index_desc":
        return "t.chronological_index IS NULL, t.chronological_index DESC, t.id DESC";
      case "abs_amount_desc":
        return "ABS(t.amount_signed) DESC, t.id DESC";
      default:
        return `${effectiveTxnDate} DESC, CASE WHEN t.source LIKE 'כ.אשראי%' THEN 1 ELSE 0 END ASC, COALESCE(t.intra_day_index, t.source_row, t.id) ASC, t.id ASC`;
    }
  })();

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM transactions t ${totalsWhereSql}`)
    .get(totalsParams);
  const total = Number(totalRow?.c || 0);
  const totalAmountRow = db
    .prepare(`SELECT SUM(t.amount_signed) AS total_amount FROM transactions t ${totalsWhereSql}`)
    .get(totalsParams);
  const totalsBreakdownRow = db
    .prepare(
      `SELECT
        SUM(CASE WHEN t.amount_signed > 0 THEN t.amount_signed ELSE 0 END) AS income_total,
        SUM(CASE WHEN t.amount_signed < 0 THEN ABS(t.amount_signed) ELSE 0 END) AS expense_total
      FROM transactions t ${totalsWhereSql}`
    )
    .get(totalsParams);
  const totalsDateRangeRow = db
    .prepare(
      `SELECT MIN(t.txn_date) AS minDate, MAX(t.txn_date) AS maxDate FROM transactions t ${totalsWhereSql}`
    )
    .get(totalsParams);
  const hasNonDateFilters =
    Boolean(q) ||
    Boolean(categoryId) ||
    Boolean(source) ||
    Boolean(direction) ||
    Boolean(min) ||
    Boolean(max) ||
    Boolean(String(monthDays || "").trim()) ||
    parsedTagIds.length > 0 ||
    parsedExcludedTagIds.length > 0 ||
    String(uncategorized || "0") === "1";
  let isDefaultDateRange = false;
  if ((from || to) && !hasNonDateFilters) {
    const rangeRow = db
      .prepare("SELECT MIN(txn_date) AS minDate, MAX(txn_date) AS maxDate FROM transactions")
      .get();
    if (rangeRow?.minDate && rangeRow?.maxDate) {
      isDefaultDateRange = from === rangeRow.minDate && to === rangeRow.maxDate;
    }
  }
  const hasFilters = hasNonDateFilters || ((from || to) && !isDefaultDateRange);
  const openingBalanceValue = hasFilters ? null : getSettingValue(db, "opening_balance");
  const openingBalance = openingBalanceValue === null ? 0 : Number(openingBalanceValue);
  const normalizedOpeningBalance = Number.isNaN(openingBalance) ? 0 : openingBalance;
  const openingBalanceApplied = hasFilters ? 0 : normalizedOpeningBalance;
  const incomeTotal = Number(totalsBreakdownRow?.income_total || 0);
  const expenseTotal = Number(totalsBreakdownRow?.expense_total || 0);
  const totalAmount =
    Number(totalAmountRow?.total_amount || 0) + openingBalanceApplied;

  const params = { ...baseParams, limit: pageSizeNum, offset };

  const rows = db
    .prepare(
      `
        SELECT t.*, c.name_he AS category_name, c.icon AS category_icon
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        ${whereSql}
        ORDER BY ${orderBy}
        LIMIT @limit OFFSET @offset
      `
    )
    .all(params);

  res.json({
    rows,
    total,
    totalAmount,
    openingBalance: openingBalanceApplied,
    incomeTotal,
    expenseTotal,
    dateRange: totalsDateRangeRow || { minDate: null, maxDate: null },
    page: pageNum,
    pageSize: pageSizeNum,
  });
});

api.get("/transactions/:id/original-entry", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const transaction = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);

    if (!transaction) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const importItem = transaction.import_id
      ? db.prepare("SELECT * FROM imports WHERE id = ?").get(transaction.import_id)
      : null;
    const fileItem = importItem || { file_name: transaction.source_file, source: transaction.source };
    const filePath = await resolveImportFilePath(fileItem);

    if (!filePath) {
      res.status(404).type("html").send(renderOriginalEntryMissingHtml({ transaction, fileItem }));
      return;
    }

    if (!isPathInsideRoot(filePath, config.processedDir)) {
      res.status(400).json({ error: "invalid_path" });
      return;
    }

    const buffer = await fs.readFile(filePath);
    const text = decodeOriginalEntryFile(buffer);

    if (text == null) {
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(path.basename(filePath))}"`);
      res.sendFile(path.resolve(filePath));
      return;
    }

    res.type("html").send(renderOriginalEntryHtml({
      transaction,
      fileName: path.basename(filePath),
      filePath,
      text,
    }));
  } catch (error) {
    res.status(500).json({ error: "server_error" });
  }
});
api.post("/transactions/reindex", (req, res) => {
  const db = getDb();
  const reindexed = reindexTransactionsChronologically(db);
  recalculateTransactionBalances(db);
  res.json({ ok: true, reindexed });
});

api.patch("/transactions/:id", express.json(), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);

  const schema = z.object({
    category_id: z.number().int().nullable().optional(),
    tags: z.array(z.number().int()).optional(),
  });
  const body = schema.parse(req.body);

  if (Object.prototype.hasOwnProperty.call(body, "category_id")) {
    if (body.category_id === null) {
      db.prepare("UPDATE transactions SET category_id = NULL WHERE id = ?").run(id);
    } else {
      const exists = db.prepare("SELECT id FROM categories WHERE id = ?").get(body.category_id);
      if (!exists) {
        res.status(400).json({ error: "category_id not found" });
        return;
      }
      db.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").run(body.category_id, id);
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "tags")) {
    const tagIds = body.tags || [];
    if (tagIds.length > 0) {
      const existingTags = db
        .prepare(
          `SELECT id FROM tags WHERE id IN (${tagIds.map(() => "?").join(", ")})`
        )
        .all(...tagIds);
      if (existingTags.length !== tagIds.length) {
        res.status(400).json({ error: "tag_ids_not_found" });
        return;
      }
    }
    db.prepare("UPDATE transactions SET tags = ? WHERE id = ?")
      .run(JSON.stringify(tagIds), id);
    recalculateTransactionBalances(db);
  }

  const row = db
    .prepare(
      `
        SELECT t.*, c.name_he AS category_name, c.icon AS category_icon
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.id = ?
      `
    )
    .get(id);

  res.json({ row });
});

api.get("/stats/summary", (req, res) => {
  const db = getDb();
  const { from, to, source } = req.query;

  const excludedTagIds = getExcludedTagIds(db);
  const { whereSql, params } = buildTxnWhere({
    from,
    to,
    source,
    excludeTagIds: excludedTagIds,
  });

  const row = db
    .prepare(
      `
        SELECT
          COUNT(*) AS count,
          SUM(CASE WHEN direction = 'expense' THEN amount_signed ELSE 0 END) AS expense_sum,
          SUM(CASE WHEN direction = 'income' THEN amount_signed ELSE 0 END) AS income_sum
        FROM transactions t
        ${whereSql}
      `
    )
    .get(params);

  const expenseSum = Number(row?.expense_sum || 0);
  const incomeSum = Number(row?.income_sum || 0);

  res.json({
    count: Number(row?.count || 0),
    expenses: Math.abs(expenseSum),
    income: incomeSum,
    net: incomeSum + expenseSum,
  });
});

// Convenience endpoint for setting sensible default date filters in the UI
api.get("/stats/date-range", (req, res) => {
  const db = getDb();
  const row = db
    .prepare("SELECT MIN(txn_date) AS minDate, MAX(txn_date) AS maxDate FROM transactions")
    .get();

  res.json({
    minDate: row?.minDate || null,
    maxDate: row?.maxDate || null,
  });
});

api.get("/stats/by-category", (req, res) => {
  const db = getDb();
  const { from, to, source, direction = "expense" } = req.query;

  const excludedTagIds = getExcludedTagIds(db);
  const isExpenseOnly = direction === "expense";
  const isIncomeOnly = direction === "income";
  const txnDirection = isExpenseOnly || isIncomeOnly ? direction : null;
  const { whereSql, params } = buildTxnWhere({
    from,
    to,
    source,
    excludeTagIds: excludedTagIds,
  });
  const txnDirectionClause = txnDirection
    ? `${whereSql ? " AND" : "WHERE"} t.direction = @txnDirection`
    : "";
  if (txnDirection) {
    params.txnDirection = txnDirection;
  }

  const rows = db
    .prepare(
      `
        SELECT
          COALESCE(c.name_he, 'לא מסווג') AS category,
          COALESCE(c.icon, '') AS icon,
          c.id AS category_id,
          SUM(t.amount_signed) AS total
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        ${whereSql}${txnDirectionClause}
        GROUP BY category, icon
        ${isExpenseOnly ? "HAVING SUM(CASE WHEN t.direction = 'expense' THEN 1 ELSE 0 END) > 0" : ""}
        ORDER BY ABS(total) DESC
        LIMIT 200
      `
    )
    .all(params);

  res.json({ rows });
});

api.get("/stats/by-tag", (req, res) => {
  const db = getDb();
  const { from, to, source, direction = "expense", categoryId, uncategorized } = req.query;

  const excludedTagIds = getExcludedTagIds(db);
  const isExpenseOnly = direction === "expense";
  const isIncomeOnly = direction === "income";
  const txnDirection = isExpenseOnly || isIncomeOnly ? direction : null;
  const { whereSql, params } = buildTxnWhere({
    from,
    to,
    source,
    categoryId,
    uncategorized,
    excludeTagIds: excludedTagIds,
  });
  const txnDirectionClause = txnDirection
    ? `${whereSql ? " AND" : "WHERE"} t.direction = @txnDirection`
    : "";
  if (txnDirection) {
    params.txnDirection = txnDirection;
  }

  const rows = db
    .prepare(
      `
        SELECT
          COALESCE(tags.name_he, 'ללא תג') AS tag,
          COALESCE(tags.icon, '') AS icon,
          tags.id AS tag_id,
          SUM(t.amount_signed) AS total
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN json_each(t.tags) AS tag_link
        LEFT JOIN tags
          ON tags.id = tag_link.value
          AND tags.exclude_from_calculations = 0
        ${whereSql}${txnDirectionClause}
        GROUP BY tag, tags.icon, tag_id
        ${isExpenseOnly ? "HAVING SUM(CASE WHEN t.direction = 'expense' THEN 1 ELSE 0 END) > 0" : ""}
        ORDER BY ABS(total) DESC
        LIMIT 200
      `
    )
    .all(params);

  res.json({ rows });
});

api.get("/stats/timeseries", (req, res) => {
  const db = getDb();
  const { from, to, group = "month", direction } = req.query;

  const where = [];
  const params = {};
  if (from) {
    where.push("txn_date >= @from");
    params.from = String(from);
  }
  if (to) {
    where.push("txn_date <= @to");
    params.to = String(to);
  }
  if (direction) {
    where.push("direction = @direction");
    params.direction = String(direction);
  }
  const excludedTagIds = getExcludedTagIds(db);
  if (excludedTagIds.length > 0) {
    const placeholders = excludedTagIds
      .map((tagId, index) => {
        const key = `excludeTagId_${index}`;
        params[key] = tagId;
        return `@${key}`;
      })
      .join(", ");
    where.push(`NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN (${placeholders}))`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const keyExpr = (() => {
    switch (group) {
      case "day":
        return "txn_date";
      case "week":
        return "strftime('%Y-W%W', txn_date)";
      case "year":
        return "strftime('%Y', txn_date)";
      case "quarter":
        return "strftime('%Y', txn_date) || '-Q' || (((CAST(strftime('%m', txn_date) AS integer)-1)/3)+1)";
      default:
        return "strftime('%Y-%m', txn_date)";
    }
  })();

  const rows = db
    .prepare(
      `
        SELECT ${keyExpr} AS k, SUM(amount_signed) AS total
        FROM transactions
        ${whereSql}
        GROUP BY k
        ORDER BY k ASC
      `
    )
    .all(params);

  res.json({ rows });
});

api.get("/stats/anomalies", (req, res) => {
  const db = getDb();
  const { from, to, minAbs = "500" } = req.query;

  const where = ["ABS(amount_signed) >= @minAbs"];
  const params = { minAbs: Number(minAbs) };
  if (from) {
    where.push("txn_date >= @from");
    params.from = String(from);
  }
  if (to) {
    where.push("txn_date <= @to");
    params.to = String(to);
  }
  const excludedTagIds = getExcludedTagIds(db);
  if (excludedTagIds.length > 0) {
    const placeholders = excludedTagIds
      .map((tagId, index) => {
        const key = `excludeTagId_${index}`;
        params[key] = tagId;
        return `@${key}`;
      })
      .join(", ");
    where.push(`NOT EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value IN (${placeholders}))`);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const rows = db
    .prepare(
      `
        SELECT t.*, c.name_he AS category_name, c.icon AS category_icon
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        ${whereSql}
        ORDER BY ABS(amount_signed) DESC
        LIMIT 100
      `
    )
    .all(params);

  res.json({ rows });
});
