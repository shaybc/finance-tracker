// Consistent SQLite snapshots with the existing database-folder backup layout.
import fs from "node:fs/promises";
import path from "node:path";

/** Copy non-database files and snapshot SQLite, never copying its live sidecars. */
export async function backupDatabaseDirectory(db, dbPath, destination) {
  const source = path.resolve(path.dirname(dbPath));
  const target = path.resolve(destination);
  const relative = path.relative(source, target);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Backup destination must be outside the database directory");
  }
  const databaseName = path.basename(dbPath);
  const excluded = new Set([databaseName, `${databaseName}-wal`, `${databaseName}-shm`, `${databaseName}-journal`]);
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source)) {
    if (!excluded.has(entry)) await fs.cp(path.join(source, entry), path.join(target, entry), { recursive: true, errorOnExist: true, force: false });
  }
  await db.backup(path.join(target, databaseName));
}
