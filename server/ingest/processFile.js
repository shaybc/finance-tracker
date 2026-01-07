import fs from "node:fs/promises";
import path from "node:path";
import XLSX from "xlsx";

import { detectSource } from "./detectors/detectSource.js";
import { parseVisaPortal } from "./parsers/visaPortalParser.js";
import { parseMax } from "./parsers/maxParser.js";
import { parseBank } from "./parsers/bankParser.js";
import { normalizeRecord } from "./normalize.js";
import { applyRulesToTransaction } from "./categorize.js";

import { getDb } from "../db/db.js";
import { toIsoDateTimeNow, yyyymmFromIsoDate } from "../utils/date.js";
import { sha256Hex } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

export async function processFile(filePath) {
  const db = getDb();
  const fileName = path.basename(filePath);

  const buf = await fs.readFile(filePath);
  const fileSha = sha256Hex(buf);

  // If file already imported -> skip but still move it to processed
  const existing = db.prepare("SELECT * FROM imports WHERE file_sha256 = ?").get(fileSha);
  if (existing) {
    logger.warn({ fileName }, "File already imported (sha256 match). Will move to processed.");
    await moveToProcessed(filePath, existing.source || "unknown", "duplicate");
    return { skipped: true, reason: "already_imported" };
  }

  const startedAt = toIsoDateTimeNow();
  const insImport = db.prepare(
    "INSERT INTO imports(file_name, source, file_sha256, started_at) VALUES (?, ?, ?, ?)"
  );

  // Load workbook once (cellDates true)
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const detected = detectSourceFromWorkbook(wb);

  const importId = insImport.run(fileName, detected.source, fileSha, startedAt).lastInsertRowid;

  try {
    let parsed = [];
    if (detected.source === "visa_portal") parsed = parseVisaPortal({ wb });
    else if (detected.source === "max") parsed = parseMax({ wb });
    else if (detected.source === "bank") parsed = parseBank({ wb });
    else parsed = [];

    const insTx = db.prepare(
      `INSERT INTO transactions
      (source, source_file, source_row, account_ref, txn_date, posting_date, merchant, description, category_raw, amount_signed, currency, direction, category_id, notes, tags, dedupe_key, raw_json, created_at)
      VALUES
      (@source, @sourceFile, @sourceRow, @accountRef, @txnDate, @postingDate, @merchant, @description, @categoryRaw, @amountSigned, @currency, @direction, NULL, NULL, @tags, @dedupeKey, @rawJson, @createdAt)`
    );

    const now = toIsoDateTimeNow();

    let rowsTotal = 0;
    let rowsInserted = 0;
    let rowsDuplicates = 0;
    let rowsFailed = 0;

    const tx = db.transaction(() => {
      for (let i = 0; i < parsed.length; i++) {
        const rec = parsed[i];
        const norm = normalizeRecord(rec, { sourceFile: fileName, sourceRow: i + 1 });
        rowsTotal++;

        const payload = {
          source: norm.source,
          sourceFile: norm.sourceFile,
          sourceRow: norm.sourceRow,
          accountRef: norm.accountRef,
          txnDate: norm.txnDate,
          postingDate: norm.postingDate,
          merchant: norm.merchant,
          description: norm.description,
          categoryRaw: norm.categoryRaw,
          amountSigned: norm.amountSigned,
          currency: norm.currency,
          direction: norm.direction,
          tags: norm.tags,
          dedupeKey: norm.dedupeKey,
          rawJson: JSON.stringify(norm.raw ?? {}, null, 0),
          createdAt: now,
        };

        try {
          const res = insTx.run(payload);
          rowsInserted++;
          applyRulesToTransaction(db, res.lastInsertRowid);
        } catch (e) {
          if (String(e?.message || "").includes("UNIQUE constraint failed: transactions.dedupe_key")) {
            rowsDuplicates++;
          } else {
            rowsFailed++;
            logger.error({ err: e, fileName, row: i + 1 }, "Insert failed");
          }
        }
      }
    });

    tx();

    db.prepare(
      "UPDATE imports SET finished_at=?, rows_total=?, rows_inserted=?, rows_duplicates=?, rows_failed=? WHERE id=?"
    ).run(toIsoDateTimeNow(), rowsTotal, rowsInserted, rowsDuplicates, rowsFailed, importId);

    await moveToProcessed(filePath, detected.source);

    logger.info({ fileName, rowsInserted, rowsDuplicates, rowsFailed }, "Import done");
    return { importId, source: detected.source, rowsTotal, rowsInserted, rowsDuplicates, rowsFailed };
  } catch (e) {
    db.prepare("UPDATE imports SET finished_at=?, error=? WHERE id=?")
      .run(toIsoDateTimeNow(), String(e?.stack || e?.message || e), importId);

    logger.error({ err: e, fileName }, "Import failed");
    await moveToProcessed(filePath, detected.source, "error");
    throw e;
  }
}

function detectSourceFromWorkbook(wb) {
  // detectSource expects filePath; we already loaded wb
  // reuse logic by checking first sheet rows
  const sheetNames = wb.SheetNames || [];
  const first = wb.Sheets[sheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(first, { header: 1, defval: "" });

  const flat = rows.slice(0, 30).flat().map((v) => String(v).trim()).join(" | ");

  if (flat.includes("₪ זכות/חובה") || flat.includes("תיאור התנועה") || sheetNames.some((s) => s.includes("עובר ושב"))) {
    return { source: "bank", wb, sheetNames };
  }
  if (flat.includes("ענף") && flat.includes("סכום") && flat.includes("שם בית")) {
    return { source: "max", wb, sheetNames };
  }
  if (flat.includes("מפתח דיסקונט") || flat.includes("תאריך חיוב") || sheetNames.some((s) => s.includes("עסקאות"))) {
    return { source: "visa_portal", wb, sheetNames };
  }

  return { source: "unknown", wb, sheetNames };
}

async function moveToProcessed(filePath, source, suffix = "") {
  const fileName = path.basename(filePath);

  // if we can infer a month, use the oldest txn_date for this file
  const db = getDb();
  let yyyymm = null;
  try {
    const row = db.prepare("SELECT MIN(txn_date) AS d FROM transactions WHERE source_file = ?").get(fileName);
    yyyymm = yyyymmFromIsoDate(row?.d);
  } catch {
    yyyymm = "unknown";
  }

  const parts = [config.processedDir, source, yyyymm].filter(Boolean);
  const destDir = path.join(...parts);
  await fs.mkdir(destDir, { recursive: true });

  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const finalName = suffix ? `${base}__${suffix}${ext}` : fileName;

  const destPath = path.join(destDir, finalName);

  // If file exists, add timestamp
  let finalPath = destPath;
  try {
    await fs.access(destPath);
    const ts = Date.now();
    finalPath = path.join(destDir, `${base}__${ts}${ext}`);
  } catch {}

  await fs.rename(filePath, finalPath);
  return finalPath;
}
