import fs from "node:fs/promises";
import path from "node:path";

import { getDb, closeDb } from "../db/db.js";
import { recalculateTransactionBalances } from "../db/balances.js";
import { config } from "../config.js";
import { normalizeRecord } from "../ingest/normalize.js";
import {
  isUtf16TabDelimitedVisaExport,
  parseUtf16TabDelimitedRows,
  parseVisaPortal,
} from "../ingest/parsers/creditCardVisaPortalParser.js";
import { extractCardLast4FromFileName } from "../utils/source.js";

const args = new Set(process.argv.slice(2));
const applyChanges = args.has("--apply");

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function moneyEquals(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(round2(a) - round2(b)) < 0.01;
}

function normalizeCompareText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function listXlsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listXlsFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xls")) {
      files.push(fullPath);
    }
  }

  return files;
}

function isSafeMatch(row, norm) {
  return normalizeCompareText(row.merchant || row.description) === normalizeCompareText(norm.merchant || norm.description);
}

function summarizeUpdate(row, norm, filePath) {
  return {
    id: row.id,
    sourceFile: row.source_file,
    sourceRow: row.source_row,
    filePath,
    date: row.txn_date,
    newDate: norm.txnDate,
    description: row.description,
    oldAmount: row.amount_signed,
    newAmount: norm.amountSigned,
    oldOriginalAmount: row.original_amount_signed,
    newOriginalAmount: norm.originalAmountSigned,
  };
}

function parseVisaPortalQuietly(options) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return parseVisaPortal(options);
  } finally {
    console.log = originalLog;
  }
}

async function main() {
  const db = getDb();
  const files = await listXlsFiles(config.processedDir);
  const selectRows = db.prepare(
    "SELECT id, source, source_file, source_row, txn_date, merchant, description, amount_signed, original_amount_signed FROM transactions WHERE source_file = ? AND source = ? AND source_row = ?"
  );
  const updateRow = db.prepare(
    `UPDATE transactions
     SET txn_date = ?, posting_date = ?, original_txn_date = ?, amount_signed = ?, original_amount_signed = ?, currency = ?, direction = ?, dedupe_key = ?, raw_json = ?
     WHERE id = ?`
  );

  const summary = {
    mode: applyChanges ? "apply" : "dry-run",
    scannedFiles: 0,
    parsedTransactions: 0,
    candidateCorrections: 0,
    updated: 0,
    skipped: 0,
    examples: [],
    skippedExamples: [],
  };

  const tx = db.transaction((updates) => {
    for (const update of updates) {
      updateRow.run(
        update.norm.txnDate,
        update.norm.postingDate,
        update.norm.originalTxnDate,
        update.norm.amountSigned,
        update.norm.originalAmountSigned,
        update.norm.currency,
        update.norm.direction,
        update.norm.dedupeKey,
        JSON.stringify(update.norm.raw ?? {}, null, 0),
        update.row.id
      );
    }
  });

  const updates = [];

  for (const filePath of files) {
    const buffer = await fs.readFile(filePath);
    if (!isUtf16TabDelimitedVisaExport(buffer)) continue;

    summary.scannedFiles++;
    const fileName = path.basename(filePath);
    const textRows = parseUtf16TabDelimitedRows(buffer);
    const parsed = parseVisaPortalQuietly({
      wb: null,
      fileCardLast4: extractCardLast4FromFileName(fileName),
      textRows,
    });
    summary.parsedTransactions += parsed.length;

    for (let i = 0; i < parsed.length; i++) {
      const norm = normalizeRecord(parsed[i], { sourceFile: fileName, sourceRow: i + 1 });
      const rows = selectRows.all(norm.sourceFile, norm.source, norm.sourceRow);
      const amountChanged = rows.length === 1 && !moneyEquals(rows[0].amount_signed, norm.amountSigned);

      if (!amountChanged) continue;

      summary.candidateCorrections++;

      if (rows.length !== 1 || !isSafeMatch(rows[0], norm)) {
        summary.skipped++;
        if (summary.skippedExamples.length < 20) {
          summary.skippedExamples.push({
            sourceFile: norm.sourceFile,
            source: norm.source,
            sourceRow: norm.sourceRow,
            parsedDate: norm.txnDate,
            parsedDescription: norm.description,
            matchesFound: rows.length,
            existing: rows[0] || null,
            parsedAmount: norm.amountSigned,
            parsedOriginalAmount: norm.originalAmountSigned,
          });
        }
        continue;
      }

      const update = { row: rows[0], norm };
      updates.push(update);
      if (summary.examples.length < 50) {
        summary.examples.push(summarizeUpdate(rows[0], norm, filePath));
      }
    }
  }

  if (applyChanges && updates.length > 0) {
    tx(updates);
    summary.updated = updates.length;
    summary.recalculatedBalances = recalculateTransactionBalances(db);
  }

  console.log(JSON.stringify(summary, null, 2));
  closeDb();
}

main().catch((err) => {
  console.error(err);
  try {
    closeDb();
  } catch {}
  process.exitCode = 1;
});



