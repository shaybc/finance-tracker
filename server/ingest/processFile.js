import fs from "node:fs/promises";
import path from "node:path";
import XLSX from "xlsx";

import { detectSource } from "./detectors/detectSource.js";
import { parseVisaPortal } from "./parsers/creditCardVisaPortalParser.js";
import { parseMax } from "./parsers/creditCardMaxParser.js";
import { parseBank } from "./parsers/bankParser.js";
import { normalizeRecord } from "./normalize.js";
import { applyRulesToTransaction } from "./categorize.js";

import { getDb } from "../db/db.js";
import { reindexTransactionsChronologically } from "../db/transactions.js";
import { toIsoDateTimeNow, yyyymmFromIsoDate } from "../utils/date.js";
import { sha256Hex } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { extractCardLast4FromFileName, formatCardSource, normalizeCardLast4 } from "../utils/source.js";

export async function processFile(filePath) {
  const db = getDb();
  const fileName = path.basename(filePath);

  const buf = await fs.readFile(filePath);
  const fileSha = sha256Hex(buf);

  // If file already imported -> skip but still move it to processed
  const existing = db.prepare("SELECT * FROM imports WHERE file_sha256 = ?").get(fileSha);
  if (existing) {
    console.log({ fileName }, " !!!! File already imported (sha256 match). Will move to processed.");
    await moveToProcessed(filePath, existing.source || "unknown", "duplicate");
    return { skipped: true, reason: "already_imported" };
  }

  const startedAt = toIsoDateTimeNow();
  const insImport = db.prepare(
    "INSERT INTO imports(file_name, source, file_sha256, started_at) VALUES (?, ?, ?, ?)"
  );

  // Load workbook once
  const wb = XLSX.read(buf, { type: "buffer" });
  const detected = detectSourceFromWorkbook(wb);
  const fileCardLast4 = extractCardLast4FromFileName(fileName);
  const detectedType = detected.source;
  console.log(">>>>> Using detectedType:", detectedType);

  const initialImportSource =
    detectedType === "bank" || detectedType === "unknown" ? detectedType : formatCardSource(fileCardLast4);

  const importId = insImport.run(fileName, initialImportSource, fileSha, startedAt).lastInsertRowid;

  try {
    let parsed = [];
    if (detectedType === "visa_portal") parsed = parseVisaPortal({ wb, fileCardLast4 });
    else if (detectedType === "max") parsed = parseMax({ wb, fileCardLast4 });
    else if (detectedType === "bank") parsed = parseBank({ wb });
    else parsed = [];

    const insTx = db.prepare(
      `INSERT INTO transactions
      (source, source_file, source_row, intra_day_index, account_ref, txn_date, posting_date, merchant, description, category_raw, original_txn_date, original_amount_signed, amount_signed, balance_amount, balance_is_calculated, currency, direction, category_id, notes, tags, dedupe_key, raw_json, created_at)
      VALUES
      (@source, @sourceFile, @sourceRow, @intraDayIndex, @accountRef, @txnDate, @postingDate, @merchant, @description, @categoryRaw, @originalTxnDate, @originalAmountSigned, @amountSigned, @balanceAmount, @balanceIsCalculated, @currency, @direction, NULL, NULL, @tags, @dedupeKey, @rawJson, @createdAt)`
    );
    const insDup = db.prepare(
      `INSERT INTO import_duplicates
      (import_id, source, source_file, source_row, account_ref, txn_date, posting_date, merchant, description, category_raw, amount_signed, currency, direction, raw_json, created_at)
      VALUES
      (@importId, @source, @sourceFile, @sourceRow, @accountRef, @txnDate, @postingDate, @merchant, @description, @categoryRaw, @amountSigned, @currency, @direction, @rawJson, @createdAt)`
    );

    const now = toIsoDateTimeNow();
    const startedAtIso = startedAt;
    const findExisting = db.prepare(
      "SELECT id FROM transactions WHERE dedupe_key = ? AND created_at < ? LIMIT 1"
    );

    let rowsTotal = 0;
    let rowsInserted = 0;
    let rowsDuplicates = 0;
    let rowsFailed = 0;
    const insertedIds = [];

    const dayCounters = new Map();

    const tx = db.transaction(() => {
      for (let i = 0; i < parsed.length; i++) {
        const rec = parsed[i];
        const norm = normalizeRecord(rec, { sourceFile: fileName, sourceRow: i + 1 });
        rowsTotal++;
        const dayKey = norm.txnDate;
        const nextIndex = (dayCounters.get(dayKey) || 0) + 1;
        dayCounters.set(dayKey, nextIndex);

        const payload = {
          source: norm.source,
          sourceFile: norm.sourceFile,
          sourceRow: norm.sourceRow,
          intraDayIndex: nextIndex,
          accountRef: norm.accountRef,
          txnDate: norm.txnDate,
          postingDate: norm.postingDate,
          merchant: norm.merchant,
          description: norm.description,
          categoryRaw: norm.categoryRaw,
          originalTxnDate: norm.originalTxnDate,
          originalAmountSigned: norm.originalAmountSigned,
          amountSigned: norm.amountSigned,
          balanceAmount: norm.balanceAmount,
          balanceIsCalculated: 0,
          currency: norm.currency,
          direction: norm.direction,
          tags: norm.tags,
          dedupeKey: norm.dedupeKey,
          rawJson: JSON.stringify(norm.raw ?? {}, null, 0),
          createdAt: now,
        };

        const existing = findExisting.get(norm.dedupeKey, startedAtIso);
        if (existing) {
          rowsDuplicates++;
          insDup.run({
            importId,
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
            rawJson: JSON.stringify(norm.raw ?? {}, null, 0),
            createdAt: now,
          });
          continue;
        }

        try {
          const res = insTx.run(payload);
          rowsInserted++;
          insertedIds.push(res.lastInsertRowid);
          applyRulesToTransaction(db, res.lastInsertRowid);
        } catch (e) {
          rowsFailed++;
          logger.error({ err: e, fileName, row: i + 1 }, "Insert failed");
        }
      }
    });

    tx();

    reindexTransactionsChronologically(db);

    const shouldRecalculateCreditCards = detectedType === "visa_portal" || detectedType === "max";
    if (!shouldRecalculateCreditCards && insertedIds.length > 0) {
      applyCalculatedBalances(db, insertedIds);
    }
    applyCalculatedBalancesForCreditCardsGlobal(db);

    const parsedCardLast4 = normalizeCardLast4(parsed.find((rec) => rec.cardLast4)?.cardLast4) || fileCardLast4;
    const finalImportSource =
      detectedType === "bank" || detectedType === "unknown"
        ? detectedType
        : formatCardSource(parsedCardLast4);

    if (finalImportSource !== initialImportSource) {
      db.prepare("UPDATE imports SET source = ? WHERE id = ?").run(finalImportSource, importId);
    }

    const processedPath = await moveToProcessed(filePath, finalImportSource);
    db.prepare(
      "UPDATE imports SET finished_at=?, rows_total=?, rows_inserted=?, rows_duplicates=?, rows_failed=?, processed_path=? WHERE id=?"
    ).run(toIsoDateTimeNow(), rowsTotal, rowsInserted, rowsDuplicates, rowsFailed, processedPath, importId);

    logger.info({ fileName, rowsInserted, rowsDuplicates, rowsFailed }, "Import done");
    return { importId, source: finalImportSource, rowsTotal, rowsInserted, rowsDuplicates, rowsFailed };
  } catch (e) {
    logger.error({ err: e, fileName }, "Import failed");
    const processedPath = await moveToProcessed(filePath, initialImportSource, "error");
    db.prepare("UPDATE imports SET finished_at=?, error=?, processed_path=? WHERE id=?")
      .run(toIsoDateTimeNow(), String(e?.stack || e?.message || e), processedPath, importId);
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
  if (
    flat.includes("4 ספרות אחרונות של כרטיס האשראי") ||
    flat.includes("כל המשתמשים")
  ) {
    return { source: "max", wb, sheetNames };
  }
  if (
    flat.includes("לכרטיס דיינרס") ||
    flat.includes("לכרטיס ויזה")
  ) {
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseTagIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => Number(item)).filter((item) => Number.isFinite(item));
    }
  } catch {
    return [];
  }
  return [];
}

function getExcludedTagIds(db) {
  return db
    .prepare("SELECT id FROM tags WHERE exclude_from_calculations = 1")
    .all()
    .map((row) => row.id);
}

function getOpeningBalanceValue(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("opening_balance");
  if (!row?.value) {
    return 0;
  }
  const parsed = Number(row.value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function hasExcludedTags(tagValue, excludedTagIds) {
  if (!excludedTagIds.size) return false;
  const tagIds = parseTagIds(tagValue);
  return tagIds.some((tagId) => excludedTagIds.has(tagId));
}

function getStartingBalance(db, row, excludedTagIds) {
  const orderValue = row.intra_day_index ?? row.source_row ?? row.id;
  const sql = `
    SELECT id, balance_amount, tags, txn_date
    FROM transactions
    WHERE balance_amount IS NOT NULL
      AND (
        txn_date < ?
        OR (
          txn_date = ?
          AND (
            COALESCE(intra_day_index, source_row, id) < ?
            OR (COALESCE(intra_day_index, source_row, id) = ? AND id < ?)
          )
        )
      )
    ORDER BY txn_date DESC, COALESCE(intra_day_index, source_row, id) DESC, id DESC
    LIMIT 50
  `;
  const params = [row.txn_date, row.txn_date, orderValue, orderValue, row.id];
  const rows = db.prepare(sql).all(...params);
  for (const candidate of rows) {
    if (!hasExcludedTags(candidate.tags, excludedTagIds)) {
      return candidate.balance_amount;
    }
  }
  return null;
}

function applyCalculatedBalances(db, insertedIds) {
  const excludedTagIds = new Set(getExcludedTagIds(db));
  const placeholders = insertedIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT id, source, account_ref, txn_date, source_row, intra_day_index, amount_signed, balance_amount, tags
        FROM transactions
        WHERE id IN (${placeholders})
      `
    )
    .all(...insertedIds);

  const updates = [];

  const rowOrderValue = (row) => row.intra_day_index ?? row.source_row ?? row.id;

  rows.sort((a, b) => {
    if (a.txn_date === b.txn_date) {
      const aOrder = rowOrderValue(a);
      const bOrder = rowOrderValue(b);
      if (aOrder === bOrder) {
        return a.id - b.id;
      }
      return aOrder - bOrder;
    }
    return String(a.txn_date).localeCompare(String(b.txn_date));
  });

  if (rows.length === 0) {
    return;
  }

  const firstRow = rows[0];
  let runningBalance = getStartingBalance(db, firstRow, excludedTagIds);

  for (const row of rows) {
    const isExcluded = hasExcludedTags(row.tags, excludedTagIds);

    if (row.balance_amount != null) {
      const balanceValue = round2(Number(row.balance_amount));
      updates.push({
        id: row.id,
        balanceAmount: balanceValue,
        balanceIsCalculated: 0,
      });
      if (!isExcluded) {
        runningBalance = balanceValue;
      }
      continue;
    }

    if (runningBalance == null) {
      continue;
    }

    const computedBalance = isExcluded
      ? runningBalance
      : round2(runningBalance + Number(row.amount_signed || 0));

    updates.push({
      id: row.id,
      balanceAmount: computedBalance,
      balanceIsCalculated: 1,
    });

    if (!isExcluded) {
      runningBalance = computedBalance;
    }
  }

  if (updates.length === 0) {
    return;
  }

  const updateStmt = db.prepare(
    "UPDATE transactions SET balance_amount = ?, balance_is_calculated = ? WHERE id = ?"
  );
  const tx = db.transaction(() => {
    updates.forEach((update) => {
      updateStmt.run(update.balanceAmount, update.balanceIsCalculated, update.id);
    });
  });
  tx();
}

export function applyCalculatedBalancesForCreditCards(db) {
  applyCalculatedBalancesForCreditCardsGlobal(db);
}

export function applyCalculatedBalancesForCreditCardsGlobal(db) {
  const excludedTagIds = new Set(getExcludedTagIds(db));
  const rows = db
    .prepare(
      `
        SELECT id, source, txn_date, posting_date, source_row, intra_day_index, chronological_index, amount_signed, balance_amount, tags
        FROM transactions
        ORDER BY chronological_index IS NULL,
          chronological_index,
          txn_date,
          CASE WHEN source LIKE 'כ.אשראי%' THEN 1 ELSE 0 END,
          source,
          COALESCE(intra_day_index, source_row, id) DESC,
          id
      `
    )
    .all();

  if (rows.length === 0) {
    return;
  }

  const updates = [];
  let runningBalance = 0;
  let currentMonthKey = null;

  const getEffectiveDateValue = (row) => {
    if (!row) {
      return null;
    }
    if (!row.txn_date) {
      return row.posting_date || null;
    }
    if (!row.posting_date) {
      return row.txn_date;
    }
    const txnDate = new Date(row.txn_date);
    const postingDate = new Date(row.posting_date);
    if (Number.isNaN(txnDate.getTime()) || Number.isNaN(postingDate.getTime())) {
      return row.txn_date;
    }
    const diffMs = postingDate.getTime() - txnDate.getTime();
    const daysDiff = diffMs / (1000 * 60 * 60 * 24);
    if (daysDiff > 31) {
      return row.posting_date;
    }
    return row.txn_date;
  };

  const getMonthKey = (dateValue) => {
    if (!dateValue) {
      return null;
    }
    const parsed = new Date(dateValue);
    if (Number.isNaN(parsed.getTime())) {
      const [year, month] = String(dateValue).split("-");
      if (year && month) {
        return `${year}-${month}`;
      }
      return null;
    }
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  };

  for (const row of rows) {
    const isCreditCard = typeof row.source === "string" && row.source.startsWith("כ.אשראי");

    if (!isCreditCard) {
      continue;
    }

    const effectiveDate = getEffectiveDateValue(row);
    const monthKey = getMonthKey(effectiveDate);
    if (monthKey && monthKey !== currentMonthKey) {
      runningBalance = 0;
      currentMonthKey = monthKey;
    }

    const isExcluded = hasExcludedTags(row.tags, excludedTagIds);
    const nextBalance = isExcluded
      ? runningBalance
      : round2(runningBalance + Number(row.amount_signed || 0));

    updates.push({
      id: row.id,
      balanceAmount: nextBalance,
      balanceIsCalculated: 1,
    });

    if (!isExcluded) {
      runningBalance = nextBalance;
    }
  }

  const updateStmt = db.prepare(
    "UPDATE transactions SET balance_amount = ?, balance_is_calculated = ? WHERE id = ?"
  );
  const tx = db.transaction(() => {
    updates.forEach((update) => {
      updateStmt.run(update.balanceAmount, update.balanceIsCalculated, update.id);
    });
  });
  tx();
}
