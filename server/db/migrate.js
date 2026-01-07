import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";
import { logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function run() {
  const db = getDb();
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");
  db.exec(sql);

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

  logger.info("DB migrated");
}

run();
