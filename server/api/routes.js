import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import multer from "multer";
import { z } from "zod";
import { closeDb, getDb } from "../db/db.js";
import { migrateDb } from "../db/migrate.js";
import { reindexTransactionsChronologically } from "../db/transactions.js";
import { applyRulesToTransaction, applySingleRuleToTransaction } from "../ingest/categorize.js";
import { applyCalculatedBalancesForCreditCardsGlobal } from "../ingest/processFile.js";
import { config } from "../config.js";
import { sha256Hex } from "../utils/hash.js";
import { extractCardLast4FromFileName } from "../utils/source.js";

export const api = express.Router();

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

const transactionPageSizeOptions = new Set([10, 20, 50, 100]);

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
  const items = db.prepare("SELECT * FROM imports ORDER BY id DESC LIMIT 50").all();
  res.json({ items });
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
    const tx = db
      .prepare("DELETE FROM transactions WHERE source_file = ? AND source = ?")
      .run(item.file_name, item.source);
    db.prepare("DELETE FROM imports WHERE id = ?").run(id);
    return tx.changes;
  })();

  reindexTransactionsChronologically(db);
  applyCalculatedBalancesForCreditCardsGlobal(db);

  res.json({ ok: true, deleted_transactions: deletedTransactions });
});

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
  });
  const body = schema.parse(req.body);

  const db = getDb();
  const now = new Date().toISOString();
  const hideFromTransactions = normalizeFlag(body.hide_from_transactions);
  const excludeFromCalculations = normalizeFlag(body.exclude_from_calculations);
  const row = db
    .prepare(
      `INSERT INTO tags(name_he, icon, hide_from_transactions, exclude_from_calculations, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(body.name_he.trim(), body.icon || null, hideFromTransactions, excludeFromCalculations, now);

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
  db.prepare(
    `UPDATE tags
     SET name_he = ?, icon = ?, hide_from_transactions = ?, exclude_from_calculations = ?
     WHERE id = ?`
  ).run(body.name_he.trim(), body.icon || null, hideFromTransactions, excludeFromCalculations, id);

  const item = db.prepare("SELECT * FROM tags WHERE id = ?").get(id);
  res.json({ item });
});

api.delete("/tags/:id", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();

  db.prepare("DELETE FROM tags WHERE id = ?").run(id);
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
  const parsed = Number(value);
  const pageSizeDefault = transactionPageSizeOptions.has(parsed) ? parsed : null;
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

  const parsed = Number(normalizedRaw);
  if (!transactionPageSizeOptions.has(parsed)) {
    res.status(400).json({ error: "invalid_page_size_default" });
    return;
  }

  const db = getDb();
  setSettingValue(db, "transactions.pageSize.default", String(parsed));
  res.json({ pageSizeDefault: parsed });
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
    .map((rule) => ({
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
      id, name_he, icon, hide_from_transactions, exclude_from_calculations, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertRule = db.prepare(
    `
      INSERT INTO rules(
        id, name, enabled, match_field, match_type, pattern, source, direction, category_id, tag_ids, amount_min, amount_max, applied_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        rule.applied_count || 0,
        rule.created_at || now
      );
    }
  });

  tx();
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
          name, enabled, match_field, match_type, pattern, source, direction, category_id, tag_ids, amount_min, amount_max, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

api.post("/rules/apply", (req, res) => {
  const db = getDb();
  const beforeUncategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NULL")
    .get().count;
  const ids = db
    .prepare("SELECT id FROM transactions")
    .all()
    .map((r) => r.id);

  let updated = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      if (applyRulesToTransaction(db, id)) updated++;
    }
  });

  tx();
  const afterUncategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NULL")
    .get().count;
  const updatedUncategorized = Math.max(0, beforeUncategorized - afterUncategorized);
  res.json({
    updated: updatedUncategorized,
    scanned: ids.length,
    updated_total: updated,
    uncategorized_before: beforeUncategorized,
    uncategorized_after: afterUncategorized,
  });
});

api.post("/rules/:id/apply", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
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
  const ids = db
    .prepare("SELECT id FROM transactions")
    .all()
    .map((r) => r.id);

  let updated = 0;
  const tx = db.transaction(() => {
    for (const txId of ids) {
      if (applySingleRuleToTransaction(db, txId, rule)) updated++;
    }
  });

  tx();
  const afterUncategorized = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE category_id IS NULL")
    .get().count;
  const updatedUncategorized = Math.max(0, beforeUncategorized - afterUncategorized);
  res.json({
    updated: updatedUncategorized,
    scanned: ids.length,
    updated_total: updated,
    uncategorized_before: beforeUncategorized,
    uncategorized_after: afterUncategorized,
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
  if (source) {
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

api.get("/transactions", (req, res) => {
  const db = getDb();

  const {
    from,
    to,
    q,
    categoryId,
    tagIds,
    source,
    direction,
    min,
    max,
    untagged,
    uncategorized,
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
    untagged,
    uncategorized,
  });

  const excludedTagIds = getExcludedTagIds(db);
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
    untagged,
    uncategorized,
    excludeTagIds: excludedTagIds,
  });

  const pageNum = Math.max(1, Number(page) || 1);
  const pageSizeNum = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const offset = (pageNum - 1) * pageSizeNum;

  const orderBy = (() => {
    switch (sort) {
      case "txn_date_asc":
        return "t.txn_date ASC, CASE WHEN t.source LIKE 'כ.אשראי%' THEN 1 ELSE 0 END ASC, COALESCE(t.intra_day_index, t.source_row, t.id) ASC, t.id ASC";
      case "txn_date_desc":
        return "t.txn_date DESC, CASE WHEN t.source LIKE 'כ.אשראי%' THEN 1 ELSE 0 END ASC, COALESCE(t.intra_day_index, t.source_row, t.id) ASC, t.id ASC";
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
      case "balance_asc":
        return "t.balance_amount ASC, t.id ASC";
      case "balance_desc":
        return "t.balance_amount DESC, t.id DESC";
      case "chronological_index_asc":
        return "t.chronological_index IS NULL, t.chronological_index ASC, t.id ASC";
      case "chronological_index_desc":
        return "t.chronological_index IS NULL, t.chronological_index DESC, t.id DESC";
      case "abs_amount_desc":
        return "ABS(t.amount_signed) DESC, t.id DESC";
      default:
        return "t.txn_date DESC, CASE WHEN t.source LIKE 'כ.אשראי%' THEN 1 ELSE 0 END ASC, COALESCE(t.intra_day_index, t.source_row, t.id) ASC, t.id ASC";
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
    parsedTagIds.length > 0 ||
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

api.post("/transactions/reindex", (req, res) => {
  const db = getDb();
  const reindexed = reindexTransactionsChronologically(db);
  applyCalculatedBalancesForCreditCardsGlobal(db);
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
  const categoryDirection = isExpenseOnly || isIncomeOnly ? direction : null;
  const { whereSql, params } = buildTxnWhere({
    from,
    to,
    source,
    excludeTagIds: excludedTagIds,
  });
  const categoryDirectionClause = categoryDirection
    ? `${whereSql ? " AND" : "WHERE"} c.direction = @categoryDirection`
    : "";
  if (categoryDirection) {
    params.categoryDirection = categoryDirection;
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
        ${whereSql}${categoryDirectionClause}
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
  const categoryDirection = isExpenseOnly || isIncomeOnly ? direction : null;
  const { whereSql, params } = buildTxnWhere({
    from,
    to,
    source,
    categoryId,
    uncategorized,
    excludeTagIds: excludedTagIds,
  });
  const shouldFilterByCategoryDirection = categoryDirection && !categoryId && uncategorized !== "1";
  const categoryDirectionClause = shouldFilterByCategoryDirection
    ? `${whereSql ? " AND" : "WHERE"} c.direction = @categoryDirection`
    : "";
  if (shouldFilterByCategoryDirection) {
    params.categoryDirection = categoryDirection;
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
        ${whereSql}${categoryDirectionClause}
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
