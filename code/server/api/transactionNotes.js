// HTTP boundary for personal notes and bounded, database-backed image uploads.
import express from "express";
import multer from "multer";
import { z } from "zod";
import { getDb } from "../db/db.js";
import { logger } from "../utils/logger.js";
import { getTransactionNotes, saveTransactionNotes, TransactionNotesError, MAX_NOTE_LENGTH, MAX_ATTACHMENTS, MAX_IMAGE_BYTES } from "../db/transactionNotes.js";

const draftSchema = z.object({
  notes: z.string().max(MAX_NOTE_LENGTH),
  expected_revision: z.number().int().nonnegative(),
  retained: z.array(z.object({ id: z.number().int().positive(), caption: z.string().max(1000) })).max(MAX_ATTACHMENTS),
  captions: z.array(z.string().max(1000)).max(MAX_ATTACHMENTS),
});
const upload = multer({ storage: multer.memoryStorage(), limits: {
  fileSize: MAX_IMAGE_BYTES, files: MAX_ATTACHMENTS, fields: 1, fieldSize: 128 * 1024, parts: MAX_ATTACHMENTS + 1,
} }).array("files", MAX_ATTACHMENTS);

function validId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new TransactionNotesError("invalid_transaction_id");
  return Number(value);
}

// Multipart defaults to Latin-1 for filenames, while browsers send UTF-8 bytes.
function uploadFilename(name) {
  if (/[^\u0000-\u00ff]/.test(name)) return name;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(name, "latin1")); }
  catch { return name; }
}

/** Create notes routes with an injectable database provider for isolated tests. */
export function createTransactionNotesRouter(database = getDb) {
  const router = express.Router();
  router.get("/transactions/:id/notes", (req, res, next) => {
    try { res.json(getTransactionNotes(database(), validId(req.params.id))); } catch (error) { next(error); }
  });
  router.put("/transactions/:id/notes", (req, res, next) => {
    upload(req, res, (error) => {
      if (error) return next(error);
      try {
        const draft = draftSchema.parse(JSON.parse(req.body?.draft || "null"));
        const files = (req.files || []).map((file) => ({ ...file, originalname: uploadFilename(file.originalname) }));
        res.json(saveTransactionNotes(database(), validId(req.params.id), draft, files));
      } catch (error) { next(error); }
    });
  });
  router.get("/transactions/:id/attachments/:attachmentId", (req, res, next) => {
    try {
      const transactionId = validId(req.params.id);
      const attachmentId = validId(req.params.attachmentId);
      const item = database().prepare("SELECT file_name, mime_type, content FROM transaction_attachments WHERE transaction_id = ? AND id = ?").get(transactionId, attachmentId);
      if (!item) throw new TransactionNotesError("attachment_not_found", 404);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      res.attachment(item.file_name);
      if (req.query.download !== "1") res.setHeader("Content-Disposition", res.getHeader("Content-Disposition").replace(/^attachment/, "inline"));
      res.type(item.mime_type).send(item.content);
    } catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (error instanceof TransactionNotesError) return res.status(error.status).json({ error: error.code });
    if (error instanceof multer.MulterError) return res.status(413).json({ error: "upload_limit_exceeded" });
    if (error instanceof z.ZodError || error instanceof SyntaxError) return res.status(400).json({ error: "invalid_notes_request" });
    logger.error({ err: error }, "Transaction notes request failed");
    res.status(500).json({ error: "notes_save_failed" });
  });
  return router;
}
