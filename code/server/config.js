import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const codeRoot = path.resolve(__dirname, "..");
const appRoot = path.resolve(codeRoot, "..");

dotenv.config({ path: path.join(appRoot, ".env") });

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3001),

  dataDir: path.resolve(appRoot, process.env.DATA_DIR || "./data"),
  inboxDir: path.resolve(appRoot, process.env.INBOX_DIR || "./data/inbox"),
  processedDir: path.resolve(appRoot, process.env.PROCESSED_DIR || "./data/processed"),
  dbPath: path.resolve(appRoot, process.env.DB_PATH || "./data/db/finance.sqlite"),

  logLevel: process.env.LOG_LEVEL || "info",
};
