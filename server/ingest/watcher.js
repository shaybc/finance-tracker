import chokidar from "chokidar";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { waitForFileStable } from "../utils/fileStable.js";
import { processFile } from "./processFile.js";

export async function startWatcher() {
  await fs.mkdir(config.inboxDir, { recursive: true });
  await fs.mkdir(config.processedDir, { recursive: true });

  const q = [];
  let working = false;

  async function enqueue(filePath) {
    q.push(filePath);
    if (!working) drain();
  }

  async function drain() {
    working = true;
    while (q.length) {
      const filePath = q.shift();
      try {
        const ok = await waitForFileStable(filePath);
        if (!ok) {
          logger.warn({ filePath }, "File not stable in time; skipping for now");
          continue;
        }
        await processFile(filePath);
      } catch (e) {
        logger.error({ err: e, filePath }, "Watcher: processing failed");
      }
    }
    working = false;
  }

  const watcher = chokidar.watch(config.inboxDir, {
    ignoreInitial: false,
    awaitWriteFinish: false, // we do our own stable check
    depth: 0,
  });

  watcher.on("add", async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (![".xlsx", ".xls"].includes(ext)) return;

    logger.info({ filePath }, "New file detected");
    enqueue(filePath);
  });

  watcher.on("error", (err) => logger.error({ err }, "Watcher error"));

  logger.info({ inboxDir: config.inboxDir }, "Watching inbox");
  return watcher;
}
