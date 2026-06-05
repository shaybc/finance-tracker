import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let db;

export function getDb() {
  if (db) return db;

  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(config.dbPath);
  db.pragma("foreign_keys = ON");
  logger.info({ dbPath: config.dbPath }, "SQLite opened");

  return db;
}

export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}
