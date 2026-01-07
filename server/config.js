import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3001),

  dataDir: path.resolve(projectRoot, process.env.DATA_DIR || "./data"),
  inboxDir: path.resolve(projectRoot, process.env.INBOX_DIR || "./data/inbox"),
  processedDir: path.resolve(projectRoot, process.env.PROCESSED_DIR || "./data/processed"),
  dbPath: path.resolve(projectRoot, process.env.DB_PATH || "./data/db/finance.sqlite"),

  logLevel: process.env.LOG_LEVEL || "info",
};
