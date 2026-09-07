// Personal transaction documentation, stored independently from imported values.
export const MAX_NOTE_LENGTH = 10000;
export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class TransactionNotesError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Read note and attachment metadata only; image bytes are fetched separately. */
export function getTransactionNotes(db, transactionId) {
  const row = db.prepare("SELECT id, notes, notes_revision, notes_updated_at FROM transactions WHERE id = ?").get(transactionId);
  if (!row) throw new TransactionNotesError("transaction_not_found", 404);
  return {
    transaction_id: row.id, notes: row.notes || "", revision: row.notes_revision,
    updated_at: row.notes_updated_at,
    attachments: db.prepare("SELECT id, file_name, mime_type, byte_size, caption, created_at FROM transaction_attachments WHERE transaction_id = ? ORDER BY id").all(transactionId),
  };
}

/** Check supported image signatures without trusting the filename or supplied MIME. */
export function imageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      buffer.toString("ascii", 12, 16) === "IHDR" && buffer.toString("ascii", buffer.length - 8, buffer.length - 4) === "IEND") return "image/png";
  if (buffer.length >= 16 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 &&
      buffer[buffer.length - 2] === 255 && buffer[buffer.length - 1] === 217) return "image/jpeg";
  if (buffer.length >= 20 && buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.readUInt32LE(4) + 8 === buffer.length && buffer.toString("ascii", 8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(buffer.toString("ascii", 12, 16))) return "image/webp";
  return null;
}

/** Save a complete note draft atomically. A stale revision never replaces newer work. */
export function saveTransactionNotes(db, transactionId, draft, files = []) {
  if (typeof draft.notes !== "string" || draft.notes.length > MAX_NOTE_LENGTH ||
      !Number.isSafeInteger(draft.expected_revision) || draft.expected_revision < 0 ||
      !Array.isArray(draft.retained) || !Array.isArray(draft.captions) || draft.captions.length !== files.length) {
    throw new TransactionNotesError("invalid_notes_request");
  }
  if (draft.retained.length + files.length > MAX_ATTACHMENTS) throw new TransactionNotesError("too_many_attachments");
  const retainedIds = draft.retained.map((item) => item.id);
  if (new Set(retainedIds).size !== retainedIds.length || retainedIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      [...draft.retained.map((item) => item.caption), ...draft.captions].some((caption) => typeof caption !== "string" || caption.length > 1000)) {
    throw new TransactionNotesError("invalid_attachment_metadata");
  }
  const uploads = files.map((file) => {
    if (!file.buffer?.length || file.buffer.length > MAX_IMAGE_BYTES) throw new TransactionNotesError("image_too_large", 413);
    const mime = imageMimeType(file.buffer);
    if (!mime || mime !== file.mimetype) throw new TransactionNotesError("unsupported_image");
    const fileName = String(file.originalname || "image").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "image";
    return { ...file, fileName, mime };
  });
  return db.transaction(() => {
    const current = getTransactionNotes(db, transactionId);
    if (current.revision !== draft.expected_revision) throw new TransactionNotesError("notes_conflict", 409);
    const ownedIds = new Set(current.attachments.map((item) => item.id));
    if (retainedIds.some((id) => !ownedIds.has(id))) throw new TransactionNotesError("attachment_not_found", 404);
    const retained = new Set(retainedIds);
    const remove = db.prepare("DELETE FROM transaction_attachments WHERE transaction_id = ? AND id = ?");
    for (const item of current.attachments) if (!retained.has(item.id)) remove.run(transactionId, item.id);
    const updateCaption = db.prepare("UPDATE transaction_attachments SET caption = ? WHERE transaction_id = ? AND id = ?");
    for (const item of draft.retained) updateCaption.run(item.caption, transactionId, item.id);
    const now = new Date().toISOString();
    const insert = db.prepare("INSERT INTO transaction_attachments (transaction_id, file_name, mime_type, byte_size, content, caption, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    uploads.forEach((file, index) => insert.run(transactionId, file.fileName, file.mime, file.buffer.length, file.buffer, draft.captions[index], now));
    db.prepare("UPDATE transactions SET notes = ?, notes_revision = notes_revision + 1, notes_updated_at = ? WHERE id = ?")
      .run(draft.notes.trim() ? draft.notes : null, now, transactionId);
    return getTransactionNotes(db, transactionId);
  }).immediate();
}
