PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_he TEXT NOT NULL UNIQUE,
  icon TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_he TEXT NOT NULL UNIQUE,
  icon TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  match_field TEXT NOT NULL,     -- merchant|description|category_raw
  match_type TEXT NOT NULL,      -- contains|regex|equals
  pattern TEXT NOT NULL,
  source TEXT,                   -- optional
  direction TEXT,                -- expense|income optional
  category_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  source TEXT NOT NULL,
  file_sha256 TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  rows_total INTEGER DEFAULT 0,
  rows_inserted INTEGER DEFAULT 0,
  rows_duplicates INTEGER DEFAULT 0,
  rows_failed INTEGER DEFAULT 0,
  processed_path TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS import_duplicates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_row INTEGER,
  account_ref TEXT,
  txn_date TEXT,
  posting_date TEXT,
  merchant TEXT,
  description TEXT,
  category_raw TEXT,
  amount_signed REAL,
  currency TEXT,
  direction TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                  -- bank|כ.אשראי (1234)
  source_file TEXT,
  source_row INTEGER,
  account_ref TEXT,                      -- card last4 / bank account
  txn_date TEXT NOT NULL,                -- YYYY-MM-DD
  posting_date TEXT,                     -- YYYY-MM-DD
  merchant TEXT,
  description TEXT,
  category_raw TEXT,
  amount_signed REAL NOT NULL,           -- expenses negative, income positive
  currency TEXT NOT NULL DEFAULT 'ILS',
  direction TEXT NOT NULL,               -- expense|income
  category_id INTEGER,
  notes TEXT,
  tags TEXT,
  dedupe_key TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_direction ON transactions(direction);
CREATE INDEX IF NOT EXISTS idx_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_source ON transactions(source);
CREATE INDEX IF NOT EXISTS idx_merchant ON transactions(merchant);
CREATE INDEX IF NOT EXISTS idx_dedupe_key ON transactions(dedupe_key);
