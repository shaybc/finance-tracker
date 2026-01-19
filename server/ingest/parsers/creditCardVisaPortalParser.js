import XLSX from "xlsx";
import { toIsoDate } from "../../utils/date.js";
import { logger } from "../../utils/logger.js";
import { formatCardSource, normalizeCardLast4 } from "../../utils/source.js";

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/[״"']/g, "")
    .replace(/[^0-9A-Za-zא-ת]/g, "")
    .trim();
}

function asNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/,/g, "").replace(/₪/g, "").replace(/"/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractCardLast4FromRows(rows) {
  const patterns = [
    /המסתיים\s+(?:ב-?|בספרות\s+)(\d{4})/,
    /לכרטיס\s\W+המסתיים ב-(\d{4})/,
    /לכרטיס\sויזה\s(\d{4})/,
    /לכרטיס\sדיינרס\s(\d{4})/,
  ];

  for (const row of rows) {
    // join row cells if it's an array
    const rowStr = Array.isArray(row) ? row.join(" ") : row;
    if (!rowStr || typeof rowStr !== 'string') continue;
    
    // Try each pattern
    for (const pattern of patterns) {
      const match = rowStr.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
  }
  
  return null; // Return null if no card number found
}

function extractChargeDate(rows) {
  const patterns = [
    /לתאריך חיוב (\d{2}\/\d{4})/,
    /עסקאות לחיוב ב-(\d{2}\/\d{2}\/\d{4})/
  ];

  for (const row of rows) {
    // join row cells if it's an array
    const rowStr = Array.isArray(row) ? row.join(" ") : row;
    if (!rowStr || typeof rowStr !== 'string') continue;
    
    // Try each pattern
    for (const pattern of patterns) {
      const match = rowStr.match(pattern);
      console.log(`Checking row for charge date: "${rowStr}", pattern: ${pattern}, match: ${match}`);
      if (match && match[1]) {
        return match[1];
      }
    }
  }
  
  return null; // Return null if no charge date found
}

function detectHeaderMap(row) {
  const normalized = row.map(normalizeHeader);
  const indexOf = (aliases) => {
    const normalizedAliases = aliases.map(normalizeHeader);
    return normalized.findIndex((value) => normalizedAliases.includes(value));
  };

  const map = {
    txnDate: indexOf(["תאריך עסקה", "תאריך העסקה"]),
    postingDate: indexOf(["תאריך חיוב", "תאריך החיוב", "מועד חיוב"]),
    merchant: indexOf(["שם בית העסק", "שם בית עסק"]),
    chargeAmount: indexOf(["סכום חיוב", "סכום החיוב", "סכום בש\"ח", "סכום בשח"]),
    originalDealAmount: indexOf(["סכום עסקה", "סכום העסקה", "סכום עסקה מקורי"]),
    typeRaw: indexOf(["סוג עסקה", "פירוט נוסף", "הערות"]),
    categoryRaw: indexOf(["קטגוריה"]),
    currency: indexOf(["מטבע חיוב", "מטבע"]),
    chargeDate: indexOf(["מועדחיוב", "מועדהחיוב"]),
  };

  if (map.txnDate === -1 || map.chargeAmount === -1 || map.merchant === -1) {
    return null;
  }

  return map;
}

export function parseVisaPortal({ wb, fileCardLast4 }) {
  const out = [];
  const sheetNames = wb.SheetNames || [];
  const targetSheets = sheetNames.filter((name) => name.includes("עסקאות"));
  if (targetSheets.length === 0 && sheetNames[0]) {
    targetSheets.push(sheetNames[0]);
  }

  for (const sheetName of targetSheets) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true }).map((row) => {
      if (row.length === 1 && typeof row[0] === "string" && row[0].includes("\t")) {
        return row[0].split("\t").map((cell) => cell.trim());
      }
      return row;
    });

    const cardLast4 = extractCardLast4FromRows(rows);
    const excelChargeDate = toIsoDate(extractChargeDate(rows));

    let headerMap = null;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const detectedHeader = detectHeaderMap(row);
      if (detectedHeader) {
        headerMap = detectedHeader;
        continue;
      }
      if (!headerMap) continue;

      if (row.every((cell) => cell == null || cell === "")) continue;
      if (row.some((cell) => String(cell || "").includes("סה\"כ"))) continue;

      const getValue = (idx) => (idx != null && idx >= 0 ? row[idx] : null);
      let txnDate = toIsoDate(getValue(headerMap.txnDate));
      const postingDate = toIsoDate(getValue(headerMap.postingDate));
      if (!txnDate) continue;

      const merchantValue = getValue(headerMap.merchant);
      const typeRawValue = getValue(headerMap.typeRaw);
      const categoryRawValue = getValue(headerMap.categoryRaw);
      const typeRaw = String(typeRawValue ?? "").trim() || null;
      const chargeDate = toIsoDate(getValue(headerMap.chargeDate)) ? toIsoDate(getValue(headerMap.chargeDate)) : excelChargeDate;
      console.log(`##!!##!!> chargeDate value: ${getValue(headerMap.chargeDate)}, parsed chargeDate: ${chargeDate}, excelChargeDate: ${excelChargeDate}`);
      const isInstallments = Boolean(
        typeRaw && (typeRaw.includes("תשלומים") || (typeRaw.includes("תשלום") && typeRaw.includes("מתוך")))
      );
      txnDate = !isInstallments ? txnDate : (toIsoDate(getValue(headerMap.chargeDate)) == null && excelChargeDate == null) ? txnDate : excelChargeDate;

      const raw = {};
      Object.entries(headerMap).forEach(([key, idx]) => {
        if (idx != null && idx >= 0) {
          raw[key] = row[idx];
        }
      });

      out.push({
        source: formatCardSource(cardLast4),
        sheet: sheetName,
        cardLast4,
        txnDate,
        postingDate,
        merchant: String(merchantValue || "").trim() || null,
        categoryRaw: String(categoryRawValue || "").trim() || null,
        typeRaw,
        amountCharge: asNumber(getValue(headerMap.chargeAmount)),
        originalAmount: asNumber(getValue(headerMap.originalDealAmount)),
        currency: String(getValue(headerMap.currency) || "₪").trim(),
        raw,
      });
    }
  }

  return out;
}
