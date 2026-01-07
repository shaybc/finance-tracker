import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { waitForFileStable } from "../utils/fileStable.js";
import { processFile } from "../ingest/processFile.js";
import "../db/migrate.js";

async function main() {
  await fs.mkdir(config.inboxDir, { recursive: true });

  const entries = await fs.readdir(config.inboxDir);
  const files = entries
    .filter((f) => [".xlsx", ".xls"].includes(path.extname(f).toLowerCase()))
    .map((f) => path.join(config.inboxDir, f));

  logger.info({ count: files.length }, "Found files in inbox");

  for (const filePath of files) {
    const ok = await waitForFileStable(filePath);
    if (!ok) {
      logger.warn({ filePath }, "Not stable - skip");
      continue;
    }
    await processFile(filePath);
  }
}

main().catch((e) => {
  logger.error({ err: e }, "ingest-once failed");
  process.exit(1);
});
