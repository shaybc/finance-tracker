import XLSX from "xlsx";
import { toIsoDate } from "../../utils/date.js";
import { formatCardSource, normalizeCardLast4 } from "../../utils/source.js";

function asNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/,/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/[^0-9A-Za-zא-ת]/g, "")
    .trim();
}

function findHeaderMap(row) {
  const normalized = row.map(normalizeHeader);
  const pick = (options) => normalized.findIndex((v) => options.includes(v));

  const map = {
    txnDate: pick(["תאריךעסקה", "תאריך"]),
    merchant: pick(["שםביתעסק", "ביתעסק"]),
    amountCharge: pick(["סכוםחיוב", "סכוםלחיוב"]),
    amountTxn: pick(["סכוםעסקה", "סכום"]),
    typeRaw: pick(["סוגעסקה"]),
    categoryRaw: pick(["ענף"]),
  };

  if (map.txnDate < 0 || map.merchant < 0 || (map.amountCharge < 0 && map.amountTxn < 0)) {
    return null;
  }

  return map;
}

export function parseMax({ wb, fileCardLast4 }) {
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });

  const out = [];
  let currentHeaderMap = null;
  let currentHeaders = null;
  const normalizedCardLast4 = normalizeCardLast4(fileCardLast4);
  let chargeDate = null;

  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const row = rows[r];
    if (!row) continue;
    const joined = row.map((cell) => String(cell ?? "")).join(" ");
    const match = joined.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    if (match) {
      const parsed = toIsoDate(match[1]);
      if (parsed) {
        chargeDate = parsed;
        break;
      }
    }
  }

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const headerMap = findHeaderMap(row);
    if (headerMap) {
      currentHeaderMap = headerMap;
      currentHeaders = row.map((h) => String(h).replace(/\n/g, " ").trim());
      continue;
    }

    if (!currentHeaderMap || !currentHeaders) continue;

    const obj = {};
    let empty = true;
    for (let c = 0; c < currentHeaders.length; c++) {
      const key = currentHeaders[c] || `col_${c}`;
      const val = row[c];
      if (val !== "" && val != null) empty = false;
      obj[key] = val;
    }
    if (empty) continue;

    const typeRaw =
      currentHeaderMap.typeRaw >= 0 ? String(row[currentHeaderMap.typeRaw] || "").trim() || null : null;
    const parsedTxnDate = toIsoDate(row[currentHeaderMap.txnDate]);
    let txnDate = parsedTxnDate;
    const isInstallments = Boolean(typeRaw && typeRaw.includes("תשלומים"));
    if (isInstallments && chargeDate) {
      txnDate = chargeDate;
    }
    if (!txnDate) continue;

    const amountValue =
      currentHeaderMap.amountCharge >= 0
        ? row[currentHeaderMap.amountCharge]
        : row[currentHeaderMap.amountTxn];
    const amountTxnValue =
      currentHeaderMap.amountTxn >= 0 ? row[currentHeaderMap.amountTxn] : null;

    out.push({
      source: formatCardSource(normalizedCardLast4),
      accountRef: null,
      cardLast4: normalizedCardLast4,
      txnDate,
      originalTxnDate: isInstallments ? parsedTxnDate : null,
      postingDate: null,
      merchant: String(row[currentHeaderMap.merchant] || "").trim() || null,
      categoryRaw:
        currentHeaderMap.categoryRaw >= 0
          ? String(row[currentHeaderMap.categoryRaw] || "").trim() || null
          : null,
      typeRaw,
      amountCharge: asNumber(amountValue),
      originalAmount: isInstallments ? asNumber(amountTxnValue) : null,
      currency: "₪",
      raw: obj,
    });
  }

  return out;
}
