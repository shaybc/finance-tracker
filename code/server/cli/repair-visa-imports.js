// Runs the Visa repair with backups and a resumable processed-file journal.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { sha256Hex } from "../utils/hash.js";
import { planVisaImportRepair, applyVisaImportRepair, processedPath, repairRevision } from "../ingest/repairVisaImports.js";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, JSON.stringify(value, null, 2));
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function verifiedPath(root, filePath) {
  processedPath(root, filePath);
  const real = await fs.realpath(filePath);
  processedPath(root, real);
  return real;
}

async function verifyHash(root, filePath, hash) {
  const real = await verifiedPath(root, filePath);
  if (sha256Hex(await fs.readFile(real)) !== hash) throw new Error(`Source changed: ${filePath}`);
}

async function assertDestinationParent(root, destination) {
  let ancestor = path.dirname(destination);
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (path.resolve(real) !== path.resolve(root)) processedPath(root, real);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
}

async function assertServerStopped(dbPath, processedDir) {
  if (path.resolve(dbPath) !== config.dbPath && path.resolve(processedDir) !== config.processedDir) return;
  const listening = await new Promise((resolve) => {
    const socket = net.createConnection({ host: config.host, port: config.port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  if (listening) throw new Error("Stop the finance server and import watcher before applying this repair");
}

function isCommitted(db, plan) {
  if (plan.files.some((file) => db.prepare("SELECT processed_path FROM imports WHERE id = ?").get(file.importId)?.processed_path !== file.newPath)) return false;
  return plan.actions.every((action) => {
    if (action.kind === "recover") {
      return !db.prepare("SELECT id FROM import_duplicates WHERE id = ?").get(action.id) && Boolean(db.prepare("SELECT id FROM transactions WHERE source_file = ? AND source_row = ? AND dedupe_key = ? AND raw_json = ?").get(action.after.source_file, action.after.source_row, action.after.dedupe_key, action.after.raw_json));
    }
    const row = db.prepare(`SELECT * FROM ${action.table} WHERE id = ?`).get(action.id);
    return action.kind === "remove" ? !row : row && Object.entries(action.after).every(([key, value]) => row[key] === value);
  });
}

/** Finish only hash-verified file cleanup after the SQLite commit. */
export async function finishVisaRepairFiles(manifest, manifestPath) {
  const root = manifest.plan.processedDir;
  const pending = [];
  for (const file of manifest.plan.files) {
    if (file.oldPath === file.newPath) continue;
    await verifyHash(root, file.newPath, file.sha256);
    try {
      await verifyHash(root, file.oldPath, file.sha256);
      await fs.unlink(file.oldPath);
    } catch (error) {
      if (["EBUSY", "EPERM", "EACCES"].includes(error.code)) pending.push({ filePath: file.oldPath, reason: error.code });
      else if (error.code !== "ENOENT") throw error;
    }
  }
  manifest.cleanupPending = pending;
  manifest.status = pending.length ? "cleanup_pending" : "complete";
  await writeJson(manifestPath, manifest);
  return pending;
}

async function resumeJournals(db, directory, processedDir) {
  let names;
  const pending = [];
  try { names = await fs.readdir(directory); } catch (error) { if (error.code === "ENOENT") return pending; throw error; }
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const manifestPath = path.join(directory, name);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (["complete", "aborted"].includes(manifest.status)) continue;
    if (manifest.plan.processedDir !== processedDir) throw new Error(`Pending repair uses a different processed directory: ${manifestPath}`);
    if (isCommitted(db, manifest.plan)) pending.push(...await finishVisaRepairFiles(manifest, manifestPath));
    else if (repairRevision(db) === manifest.plan.revision) {
      for (const filePath of manifest.createdCopies || []) {
        const file = manifest.plan.files.find((file) => file.newPath === filePath);
        if (!file || file.oldPath === file.newPath) throw new Error("Invalid staged copy in repair journal");
        await verifyHash(processedDir, file.oldPath, file.sha256);
        try { await verifyHash(processedDir, file.newPath, file.sha256); await fs.unlink(file.newPath); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      manifest.status = "aborted";
      await writeJson(manifestPath, manifest);
    } else throw new Error(`Review interrupted repair before continuing: ${manifestPath}`);
  }
  return pending;
}

/** Dry-run by default; applying requires a stopped server and verified source files. */
export async function runVisaImportRepair({ apply = false, dbPath = config.dbPath, processedDir = config.processedDir, reportPath = null } = {}) {
  dbPath = path.resolve(dbPath);
  processedDir = await fs.realpath(processedDir);
  if (reportPath && (path.resolve(reportPath) === dbPath || path.resolve(reportPath).startsWith(`${processedDir}${path.sep}`))) throw new Error("Repair report must not overwrite the database or processed files");
  if (apply) await assertServerStopped(dbPath, processedDir);
  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  db.pragma("foreign_keys = ON");
  const journalDir = `${dbPath}.visa-repairs`;
  try {
    const cleanupPending = apply ? await resumeJournals(db, journalDir, processedDir) : [];
    const plan = await planVisaImportRepair(db, { processedDir });
    if (reportPath) await writeJson(path.resolve(reportPath), plan);
    if (!apply) return { mode: "dry-run", ...plan.summary, unresolved: plan.unresolved, statements: plan.statements };
    if (plan.unresolved.length) throw new Error(`Repair blocked: ${plan.unresolved.length} unresolved issues. Run with --report to inspect them.`);
    if (!plan.actions.length && !plan.summary.changedPaths) return { mode: "apply", ...plan.summary, changed: false, cleanupPending };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.mkdir(journalDir, { recursive: true });
    const backupPath = path.join(journalDir, `${stamp}.sqlite`);
    const manifestPath = path.join(journalDir, `${stamp}.json`);
    await db.backup(backupPath);
    const manifest = { status: "planned", dbPath, backupPath, createdCopies: [], plan };
    await writeJson(manifestPath, manifest);
    for (const file of plan.files) {
      await verifyHash(processedDir, file.oldPath, file.sha256);
      if (file.oldPath === file.newPath) continue;
      await assertDestinationParent(processedDir, file.newPath);
      await fs.mkdir(path.dirname(file.newPath), { recursive: true });
      try {
        // Journal intent first so a crash immediately after copy is recoverable.
        await fs.access(file.newPath);
        await verifyHash(processedDir, file.newPath, file.sha256);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        manifest.createdCopies.push(file.newPath);
        await writeJson(manifestPath, manifest);
        await fs.copyFile(file.oldPath, file.newPath, constants.COPYFILE_EXCL);
        await verifyHash(processedDir, file.newPath, file.sha256);
      }
    }
    manifest.status = "staged";
    await writeJson(manifestPath, manifest);
    await assertServerStopped(dbPath, processedDir);
    manifest.result = applyVisaImportRepair(db, plan);
    manifest.status = "committed";
    await writeJson(manifestPath, manifest);
    cleanupPending.push(...await finishVisaRepairFiles(manifest, manifestPath));
    const verification = await planVisaImportRepair(db, { processedDir });
    if (verification.unresolved.length || verification.actions.length || verification.summary.changedPaths) throw new Error(`Post-repair verification needs review; backup and journal: ${manifestPath}`);
    return { mode: "apply", ...plan.summary, backupPath, manifestPath, verification: "passed", cleanupPending, result: manifest.result };
  } finally { db.close(); }
}

/** Parse the documented repair command flags without initializing or migrating SQLite. */
export async function runVisaRepairCli(args = process.argv.slice(2)) {
  const options = {};
  const flags = { "--db": "dbPath", "--processed-dir": "processedDir", "--report": "reportPath" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") options.apply = true;
    else if (flags[args[i]] && args[i + 1] && !args[i + 1].startsWith("--")) options[flags[args[i]]] = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  const result = await runVisaImportRepair(options);
  console.log(JSON.stringify(result, null, 2));
  if (Array.isArray(result.unresolved) && result.unresolved.length) process.exitCode = 1;
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runVisaRepairCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
