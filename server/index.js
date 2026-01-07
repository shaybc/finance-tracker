import path from "node:path";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { api } from "./api/routes.js";
import { startWatcher } from "./ingest/watcher.js";
import "./db/migrate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

app.use("/api", api);

const args = new Set(process.argv.slice(2));
const serveClient = args.has("--serve-client");

if (serveClient) {
  const clientDist = path.resolve(__dirname, "../client/dist");
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("*", (req, res) => res.sendFile(path.join(clientDist, "index.html")));
    logger.info({ clientDist }, "Serving client dist");
  } else {
    logger.warn({ clientDist }, "Client dist not found. Run: npm run build");
  }
}

app.listen(config.port, config.host, async () => {
  logger.info({ host: config.host, port: config.port }, "Server listening");
  await startWatcher();
});
