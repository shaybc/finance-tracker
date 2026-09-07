import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { getDb, closeDb } from "../db/db.js";
import { migrateDb } from "../db/migrate.js";
import { api } from "./routes.js";
import { getTransactionNotes, saveTransactionNotes, MAX_IMAGE_BYTES, imageMimeType } from "../db/transactionNotes.js";
import { backupDatabaseDirectory } from "../db/backup.js";
import { applyRulesToTransaction } from "../ingest/categorize.js";
import { applyVisaImportRepair, repairRevision } from "../ingest/repairVisaImports.js";

const schema = await fs.readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4o0AAAAASUVORK5CYII=", "base64");
const file = (name = "receipt.png") => ({ originalname: name, mimetype: "image/png", buffer: png });
const draft = (notes = "", revision = 0, retained = [], captions = []) => ({ notes, expected_revision: revision, retained, captions });
const failure = (code) => (error) => error.code === code;

function insertTransaction(db, id = 1, amount = -25) {
  db.prepare("INSERT INTO transactions (id, source, source_file, source_row, txn_date, merchant, description, amount_signed, direction, notes, tags, dedupe_key, raw_json, created_at, real_balance_after, affected_balance_after) VALUES (?, 'bank', 'statement.xls', ?, '2026-09-01', 'Original merchant', 'Original description', ?, ?, NULL, NULL, ?, '{}', '2026-09-01T10:00:00Z', 500, 500)")
    .run(id, id, amount, amount < 0 ? "expense" : "income", `test-${id}`);
}

function database(t) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON"); db.exec(schema); insertTransaction(db); insertTransaction(db, 2, 10);
  t.after(() => db.close());
  return db;
}

async function apiFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transaction-notes-test-"));
  const previous = { ...config };
  closeDb();
  config.dbPath = path.join(directory, "db", "finance.sqlite");
  config.dataDir = directory; config.processedDir = path.join(directory, "processed");
  await fs.mkdir(config.processedDir);
  const db = getDb(); db.exec(schema); insertTransaction(db); insertTransaction(db, 2, 10);
  const app = express(); app.use("/api", api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb(); Object.assign(config, previous);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const put = (id, data, files = []) => {
    const form = new FormData(); form.append("draft", JSON.stringify(data));
    for (const image of files) form.append("files", new Blob([image.buffer], { type: image.mimetype }), image.originalname);
    return fetch(`${url}/transactions/${id}/notes`, { method: "PUT", body: form });
  };
  return { db, directory, url, put };
}

test("notes and attachments save atomically without changing financial or imported data", (t) => {
  const db = database(t);
  const before = db.prepare("SELECT * FROM transactions WHERE id=1").get();
  const result = saveTransactionNotes(db, 1, draft("  A personal note\nשלום", 0, [], ["A receipt"]), [file()]);
  assert.equal(result.revision, 1); assert.equal(result.notes, "  A personal note\nשלום");
  assert.equal(result.attachments.length, 1); assert.equal(result.attachments[0].content, undefined);
  assert.deepEqual(db.prepare("SELECT content FROM transaction_attachments").get().content, png);
  const after = db.prepare("SELECT * FROM transactions WHERE id=1").get();
  for (const key of Object.keys(before).filter((key) => !["notes", "notes_revision", "notes_updated_at"].includes(key))) assert.deepEqual(after[key], before[key], key);
  const edited = saveTransactionNotes(db, 1, draft("updated", 1, [{ id: result.attachments[0].id, caption: "edited" }]));
  assert.equal(edited.attachments[0].caption, "edited");
  const removed = saveTransactionNotes(db, 1, draft("", 2));
  assert.equal(removed.attachments.length, 0); assert.equal(db.prepare("SELECT notes FROM transactions WHERE id=1").get().notes, null);
});

test("stale drafts, foreign attachment IDs and invalid requests leave saved data unchanged", (t) => {
  const db = database(t);
  const saved = saveTransactionNotes(db, 1, draft("first", 0, [], [""]), [file()]);
  const snapshot = () => [getTransactionNotes(db, 1), getTransactionNotes(db, 2), db.prepare("SELECT * FROM transaction_attachments").all()];
  const before = snapshot();
  assert.throws(() => saveTransactionNotes(db, 1, draft("stale", 0)), failure("notes_conflict"));
  assert.throws(() => saveTransactionNotes(db, 2, draft("steal", 0, [{ id: saved.attachments[0].id, caption: "" }])), failure("attachment_not_found"));
  assert.throws(() => saveTransactionNotes(db, 1, draft("x".repeat(10001), 1)), failure("invalid_notes_request"));
  assert.throws(() => saveTransactionNotes(db, 1, draft("bad", 1, [], [""]), [{ ...file(), buffer: Buffer.from("<svg onload='bad'>") }]), failure("unsupported_image"));
  assert.throws(() => saveTransactionNotes(db, 1, draft("bad", 1, [], [""]), [{ ...file(), mimetype: "image/jpeg" }]), failure("unsupported_image"));
  assert.throws(() => saveTransactionNotes(db, 1, draft("bad", 1, [], [""]), [{ ...file(), buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1) }]), failure("image_too_large"));
  assert.throws(() => saveTransactionNotes(db, 1, draft("bad", 1, [], Array(6).fill("")), Array.from({ length: 6 }, () => file())), failure("too_many_attachments"));
  assert.deepEqual(snapshot(), before);
  assert.throws(() => getTransactionNotes(db, 999), failure("transaction_not_found"));
});

test("database errors roll back attachment removals and note revisions", (t) => {
  const db = database(t);
  saveTransactionNotes(db, 1, draft("keep", 0, [], ["keep"]), [file()]);
  db.exec("CREATE TRIGGER fail_notes BEFORE UPDATE OF notes ON transactions BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.throws(() => saveTransactionNotes(db, 1, draft("discard", 1)), /test failure/);
  assert.equal(getTransactionNotes(db, 1).revision, 1);
  assert.equal(getTransactionNotes(db, 1).attachments.length, 1);
});

test("HTTP metadata, uploads, images, ownership and conflict responses", async (t) => {
  const { url, put } = await apiFixture(t);
  const response = await put(1, draft("invoice", 0, [], ["receipt"]), [file("\u05e7\u05d1\u05dc\u05d4.png")]);
  assert.equal(response.status, 200);
  const result = await response.json(); const attachmentId = result.attachments[0].id;
  assert.equal(result.attachments[0].file_name, "\u05e7\u05d1\u05dc\u05d4.png");
  const metadata = await (await fetch(`${url}/transactions/1/notes`)).json();
  assert.deepEqual(metadata, result); assert.equal(JSON.stringify(metadata).includes("base64"), false);
  const image = await fetch(`${url}/transactions/1/attachments/${attachmentId}`);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.match(image.headers.get("content-disposition"), /^inline/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const download = await fetch(`${url}/transactions/1/attachments/${attachmentId}?download=1`);
  assert.match(download.headers.get("content-disposition"), /^attachment/); await download.arrayBuffer();
  assert.equal((await fetch(`${url}/transactions/2/attachments/${attachmentId}`)).status, 404);
  assert.equal((await put(1, draft("conflict", 0))).status, 409);
  assert.equal((await put(999, draft("missing"))).status, 404);
  assert.equal((await put(1, draft("fake", 1, [], [""]), [{ ...file(), buffer: Buffer.from("not an image") }])).status, 400);
  assert.equal((await put(1, draft("big", 1, [], [""]), [{ ...file(), buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1) }])).status, 413);
});

test("notes and multiple attachment search matches return each transaction once with correct totals", async (t) => {
  const { db, url } = await apiFixture(t);
  saveTransactionNotes(db, 1, draft("search-token", 0, [], ["search-token", "search-token"]), [file("search-token.png"), file("second.png")]);
  saveTransactionNotes(db, 2, draft("", 0, [], ["other"]), [file("other.png")]);
  for (const query of ["q=search-token", "documentation=notes", "documentation=attachments&q=search-token", "q=second.png"]) {
    const result = await (await fetch(`${url}/transactions?${query}&pageSize=1&includeExcludedFromCalculations=1`)).json();
    assert.equal(result.total, 1, query); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].id, 1);
    assert.equal(result.totalAmount, -25); assert.equal(result.expenseTotal, 25);
    assert.equal(result.rows[0].attachment_count, 2); assert.equal(result.rows[0].content, undefined);
  }
  const second = await (await fetch(`${url}/transactions?documentation=attachments&pageSize=1&page=2`)).json();
  assert.equal(second.total, 2); assert.equal(second.rows.length, 1); assert.equal(second.totalAmount, -15);
  const noMatches = await (await fetch(`${url}/transactions?documentation=notes&min=0`)).json();
  assert.equal(noMatches.total, 0); assert.equal(noMatches.totalAmount, 0);
});

test("additive migration preserves existing notes and attachment data on repeat runs", async (t) => {
  const { db } = await apiFixture(t);
  db.exec("DROP TABLE transaction_attachments; ALTER TABLE transactions DROP COLUMN notes_revision; ALTER TABLE transactions DROP COLUMN notes_updated_at");
  db.prepare("UPDATE transactions SET notes = ? WHERE id=1").run("Existing personal note");
  migrateDb();
  assert.equal(getTransactionNotes(db, 1).notes, "Existing personal note"); assert.equal(getTransactionNotes(db, 1).revision, 0);
  saveTransactionNotes(db, 1, draft("preserved", 0, [], ["caption"]), [file()]);
  const before = getTransactionNotes(db, 1);
  migrateDb();
  assert.deepEqual(getTransactionNotes(db, 1), before);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
});

test("SQLite snapshot includes image bytes and companion files but not live sidecars", async (t) => {
  const { db, directory } = await apiFixture(t);
  db.pragma("journal_mode = WAL");
  saveTransactionNotes(db, 1, draft("backup-note", 0, [], ["backup-caption"]), [file()]);
  await fs.writeFile(path.join(directory, "db", "companion.txt"), "preserve me");
  const destination = path.join(directory, "backup");
  await backupDatabaseDirectory(db, config.dbPath, destination);
  const files = await fs.readdir(destination);
  assert.deepEqual(files.sort(), ["companion.txt", "finance.sqlite"]);
  const restored = new Database(path.join(destination, "finance.sqlite"));
  assert.equal(getTransactionNotes(restored, 1).notes, "backup-note");
  assert.deepEqual(restored.prepare("SELECT content FROM transaction_attachments").get().content, png);
  assert.equal(restored.pragma("integrity_check", { simple: true }), "ok"); restored.close();
  await assert.rejects(backupDatabaseDirectory(db, config.dbPath, path.join(directory, "db", "nested")), /outside/);
});

test("existing backup and restore endpoints retain complete notes and attachments", async (t) => {
  const { db, url, directory } = await apiFixture(t);
  saveTransactionNotes(db, 1, draft("restore-note", 0, [], [""]), [file()]);
  const target = path.join(directory, "backups"); await fs.mkdir(target);
  const post = (endpoint, body) => fetch(`${url}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const response = await post("/settings/backup", { destination: target }); assert.equal(response.status, 200);
  const backup = await response.json();
  saveTransactionNotes(db, 1, draft("changed", 1));
  assert.equal((await post("/settings/restore", { source: backup.destination })).status, 200);
  const result = await (await fetch(`${url}/transactions/1/notes`)).json();
  assert.equal(result.notes, "restore-note"); assert.equal(result.attachments.length, 1);
  assert.deepEqual(getDb().prepare("SELECT content FROM transaction_attachments").get().content, png);
});

test("rules and in-place import repairs preserve annotations; import deletion cascades", async (t) => {
  const { db, url } = await apiFixture(t);
  saveTransactionNotes(db, 1, draft("keep annotations", 0, [], ["image"]), [file()]);
  db.exec("INSERT INTO categories(id, name_he, created_at) VALUES (1, 'Test category', '2026-01-01'); INSERT INTO rules(name, match_field, match_type, pattern, category_id, created_at) VALUES ('Test rule', 'merchant', 'contains', 'Original', 1, '2026-01-01')");
  const before = getTransactionNotes(db, 1);
  applyRulesToTransaction(db, 1);
  assert.deepEqual(getTransactionNotes(db, 1), before);
  const tx = db.prepare("SELECT * FROM transactions WHERE id=1").get();
  const fields = ["txn_date", "posting_date", "original_txn_date", "amount_signed", "original_amount_signed", "currency", "direction", "dedupe_key", "raw_json"];
  applyVisaImportRepair(db, { unresolved: [], revision: repairRevision(db), actions: [{ kind: "update", table: "transactions", id: 1, importId: 999, after: Object.fromEntries(fields.map((field) => [field, tx[field]])) }], files: [] });
  assert.deepEqual(getTransactionNotes(db, 1), before);
  db.exec("INSERT INTO imports (id, file_name, file_sha256, source, started_at, finished_at) VALUES (1, 'statement.xls', 'hash', 'bank', '2026-09-01T09:00:00Z', '2026-09-01T11:00:00Z')");
  const deleted = await fetch(`${url}/imports/1`, { method: "DELETE" });
  assert.equal(deleted.status, 200); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transaction_attachments").get().n, 0);
  assert.equal(db.pragma("foreign_key_check").length, 0);
});

test("supported signatures reject incomplete PNG and disguised text", () => {
  assert.equal(imageMimeType(png), "image/png");
  assert.equal(imageMimeType(png.subarray(0, 30)), null);
  assert.equal(imageMimeType(Buffer.from("<html>receipt</html>")), null);
});

test("all supported image formats and exact note/count limits preserve original bytes", (t) => {
  const db = database(t);
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABwn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAYqm//Z", "base64");
  const webp = Buffer.from("UklGRh4CAABXRUJQVlA4WAoAAAAgAAAAAQAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggMAAAANABAJ0BKgIAAgABQCYloAJ0ugH4AAOwAP7y63/82BXNc+/3/9Lg/S4P0uD/0pAAAA==", "base64");
  const uploads = [file(), { originalname: "receipt.jpg", mimetype: "image/jpeg", buffer: jpeg },
    { originalname: "receipt.webp", mimetype: "image/webp", buffer: webp }, file(), file()];
  const result = saveTransactionNotes(db, 1, draft("x".repeat(10000), 0, [], Array(5).fill("")), uploads);
  assert.equal(result.notes.length, 10000); assert.equal(result.attachments.length, 5);
  const rows = db.prepare("SELECT mime_type, content FROM transaction_attachments ORDER BY id").all();
  rows.forEach((row, index) => {
    assert.equal(row.mime_type, uploads[index].mimetype);
    assert.deepEqual(row.content, uploads[index].buffer);
  });
});
