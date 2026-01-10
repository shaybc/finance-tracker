import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";
import { logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function migrateDb() {
  const db = getDb();
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");
  db.exec(sql);

  const importsColumns = db.prepare("PRAGMA table_info(imports)").all().map((row) => row.name);
  if (!importsColumns.includes("processed_path")) {
    db.exec("ALTER TABLE imports ADD COLUMN processed_path TEXT");
  }

  const txnIndexes = db.prepare("PRAGMA index_list(transactions)").all();
  const dedupeUnique = txnIndexes.some((idx) => {
    if (!idx.unique) return false;
    const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all();
    return cols.some((col) => col.name === "dedupe_key");
  });

  if (dedupeUnique) {
    db.exec("BEGIN");
    db.exec(`CREATE TABLE transactions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_file TEXT,
      source_row INTEGER,
      account_ref TEXT,
      txn_date TEXT NOT NULL,
      posting_date TEXT,
      merchant TEXT,
      description TEXT,
      category_raw TEXT,
      original_txn_date TEXT,
      original_amount_signed REAL,
      amount_signed REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ILS',
      direction TEXT NOT NULL,
      category_id INTEGER,
      notes TEXT,
      tags TEXT,
      dedupe_key TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )`);
    db.exec(`INSERT INTO transactions_new
      (id, source, source_file, source_row, account_ref, txn_date, posting_date, merchant, description, category_raw, original_txn_date, original_amount_signed, amount_signed, currency, direction, category_id, notes, tags, dedupe_key, raw_json, created_at)
      SELECT id, source, source_file, source_row, account_ref, txn_date, posting_date, merchant, description, category_raw, NULL AS original_txn_date, NULL AS original_amount_signed, amount_signed, currency, direction, category_id, notes, tags, dedupe_key, raw_json, created_at
      FROM transactions`);
    db.exec("DROP TABLE transactions");
    db.exec("ALTER TABLE transactions_new RENAME TO transactions");
    db.exec("CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_direction ON transactions(direction)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_category ON transactions(category_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_source ON transactions(source)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_merchant ON transactions(merchant)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_dedupe_key ON transactions(dedupe_key)");
    db.exec("COMMIT");
    logger.info("Removed unique constraint on transactions.dedupe_key");
  }

  const rulesColumns = db.prepare("PRAGMA table_info(rules)").all();
  const rulesColumnNames = rulesColumns.map((row) => row.name);
  const rulesCategoryNotNull = rulesColumns.find((row) => row.name === "category_id")?.notnull === 1;
  const rulesMissingTagIds = !rulesColumnNames.includes("tag_ids");
  const rulesMissingAppliedCount = !rulesColumnNames.includes("applied_count");
  const rulesNeedRebuild = rulesMissingTagIds || rulesCategoryNotNull;
  if (rulesNeedRebuild) {
    db.exec("BEGIN");
    db.exec(`CREATE TABLE rules_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      match_field TEXT NOT NULL,
      match_type TEXT NOT NULL,
      pattern TEXT NOT NULL,
      source TEXT,
      direction TEXT,
      category_id INTEGER,
      tag_ids TEXT,
      applied_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )`);
    const insertColumns = [
      "id",
      "name",
      "enabled",
      "match_field",
      "match_type",
      "pattern",
      "source",
      "direction",
      "category_id",
      rulesColumnNames.includes("tag_ids") ? "tag_ids" : null,
      rulesColumnNames.includes("applied_count") ? "applied_count" : null,
      "created_at",
    ].filter(Boolean);
    db.exec(`INSERT INTO rules_new (${insertColumns.join(", ")})
      SELECT ${insertColumns.join(", ")} FROM rules`);
    db.exec("DROP TABLE rules");
    db.exec("ALTER TABLE rules_new RENAME TO rules");
    db.exec("COMMIT");
    logger.info("Updated rules table for tag support");
  }
  if (rulesMissingAppliedCount && !rulesNeedRebuild) {
    db.exec("ALTER TABLE rules ADD COLUMN applied_count INTEGER NOT NULL DEFAULT 0");
    logger.info("Added rules.applied_count");
  }

  const tagColumns = db.prepare("PRAGMA table_info(tags)").all().map((row) => row.name);
  if (!tagColumns.includes("hide_from_transactions")) {
    db.exec("ALTER TABLE tags ADD COLUMN hide_from_transactions INTEGER NOT NULL DEFAULT 0");
    logger.info("Added tags.hide_from_transactions");
  }
  if (!tagColumns.includes("exclude_from_calculations")) {
    db.exec("ALTER TABLE tags ADD COLUMN exclude_from_calculations INTEGER NOT NULL DEFAULT 0");
    logger.info("Added tags.exclude_from_calculations");
  }

  const txnColumns = db.prepare("PRAGMA table_info(transactions)").all().map((row) => row.name);
  if (!txnColumns.includes("original_txn_date")) {
    db.exec("ALTER TABLE transactions ADD COLUMN original_txn_date TEXT");
    logger.info("Added transactions.original_txn_date");
  }
  if (!txnColumns.includes("original_amount_signed")) {
    db.exec("ALTER TABLE transactions ADD COLUMN original_amount_signed REAL");
    logger.info("Added transactions.original_amount_signed");
  }

  // Seed categories if empty
  const count = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
  if (count === 0) {
    const now = new Date().toISOString();
    const defaults = [
      ["אוכל", "🍔"],
      ["מסעדות", "🍽️"],
      ["חשבונות", "💡"],
      ["תחבורה", "🚗"],
      ["קניות", "🛒"],
      ["בריאות", "🩺"],
      ["ביטוח", "🛡️"],
      ["פנאי", "🎮"],
      ["תיירות", "✈️"],
      ["דיור", "🏠"],
      ["שכר/הכנסה", "💰"],
      ["העברות", "🔁"],
      ["אחר", "📦"],
    ];
    const ins = db.prepare("INSERT INTO categories(name_he, icon, created_at) VALUES (?, ?, ?)");
    const tx = db.transaction(() => defaults.forEach(([n, i]) => ins.run(n, i, now)));
    tx();
    logger.info("Seeded default categories");
  }

  const tagsCount = db.prepare("SELECT COUNT(*) AS c FROM tags").get().c;
  if (tagsCount === 0) {
    const now = new Date().toISOString();
    const defaults = [
      "ביטוח רכב",
      "ביטוח דירה",
      "ביטוח בריאות",
      "ביטוח חיים",
      "ביטוח נסיעות",
      "טיולים וחופשות",
      "מסעדות ומשלוחים",
      "ועד בית",
      "ארנונה",
      "דלק",
      "חניה",
      "טיפול רכב",
      "קנסות",
      "תחבורה ציבורית",
      "תרומות",
      "מתנות",
      "חד-פעמי",
      "בונוס",
    ];
    const ins = db.prepare("INSERT INTO tags(name_he, icon, created_at) VALUES (?, ?, ?)");
    const tx = db.transaction(() => defaults.forEach((name) => ins.run(name, null, now)));
    tx();
    logger.info("Seeded default tags");
  }

  logger.info("DB migrated");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrateDb();
}
