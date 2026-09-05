import { getDb, closeDb } from "../db/db.js";
import { recalculateTransactionBalances } from "../db/balances.js";
import { reindexTransactionsChronologically } from "../db/transactions.js";

const args = new Set(process.argv.slice(2));
const applyChanges = args.has("--apply");

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/[״"']/g, "")
    .replace(/[^0-9A-Za-zא-ת]/g, "")
    .trim();
}

function parseRawJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function isChargeAmountHeader(header) {
  const normalized = normalizeHeader(header);
  return ["סכוםחיוב", "סכוםהחיוב", "סכוםבשח"].includes(normalized);
}

function asNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  const number = Number(String(value).replace(/,/g, "").replace(/[₪$]/g, "").replace(/"/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function getRawText(raw) {
  return Object.values(raw)
    .map((value) => String(value ?? ""))
    .join(" ");
}

function hasPendingMarker(raw) {
  return getRawText(raw).includes("עסקה בקליטה");
}

function getChargeAmountEntries(raw) {
  return Object.entries(raw).filter(([key]) => isChargeAmountHeader(key));
}

function hasBlankChargeAmount(raw) {
  const entries = getChargeAmountEntries(raw);
  return entries.length > 0 && entries.every(([, value]) => String(value ?? "").trim() === "");
}

function hasZeroChargeAmount(raw) {
  const entries = getChargeAmountEntries(raw);
  return entries.length > 0 && entries.some(([, value]) => asNumber(value) === 0);
}

function summarizeRow(row, raw) {
  return {
    id: row.id,
    date: row.txn_date,
    source: row.source,
    sourceFile: row.source_file,
    sourceRow: row.source_row,
    merchant: row.merchant,
    amount: row.amount_signed,
    pendingMarker: hasPendingMarker(raw),
    blankChargeAmount: hasBlankChargeAmount(raw),
    zeroChargeAmount: hasZeroChargeAmount(raw),
  };
}

function main() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, source, source_file, source_row, txn_date, merchant, amount_signed, raw_json
       FROM transactions
       WHERE source LIKE 'כ.אשראי%'
       ORDER BY txn_date, id`
    )
    .all();

  const matches = rows
    .map((row) => ({ row, raw: parseRawJson(row.raw_json) }))
    .filter(({ row, raw }) => hasPendingMarker(raw) || hasBlankChargeAmount(raw) || (Number(row.amount_signed || 0) === 0 && hasZeroChargeAmount(raw)));

  const summary = {
    mode: applyChanges ? "apply" : "dry-run",
    scannedCreditCardRows: rows.length,
    matchedRows: matches.length,
    deletedRows: 0,
    examples: matches.slice(0, 50).map(({ row, raw }) => summarizeRow(row, raw)),
  };

  if (applyChanges && matches.length > 0) {
    const deleteRow = db.prepare("DELETE FROM transactions WHERE id = ?");
    const tx = db.transaction(() => {
      matches.forEach(({ row }) => deleteRow.run(row.id));
    });
    tx();
    summary.deletedRows = matches.length;
    summary.reindexed = reindexTransactionsChronologically(db);
    summary.recalculatedBalances = recalculateTransactionBalances(db);
  }

  console.log(JSON.stringify(summary, null, 2));
  closeDb();
}

main();