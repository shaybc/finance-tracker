import XLSX from "xlsx";
import { toIsoDate } from "../../utils/date.js";
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
  const candidates = [];
  const headerRows = rows.slice(0, 50);
  const headerLast4Pattern = /מסתיים\s*ב\s*-?\s*(\d{4})/;

  const addMatches = (text) => {
    if (!text || text.includes("/") || text.includes(":")) return;
    const matches = text.match(/\d{4}/g);
    if (matches && matches.length > 0) {
      candidates.push(...matches);
    }
  };

  for (const row of headerRows) {
    const values = row.map((cell) => String(cell || "").trim()).filter(Boolean);
    if (values.length === 0) continue;

    const rowText = values.join(" ");
    const headerMatch = rowText.match(headerLast4Pattern);
    if (headerMatch) {
      return normalizeCardLast4(headerMatch[1]);
    }

    const rowHasCardHint = values.some(
      (text) => text.includes("כרטיס") || text.includes("ויזה") || text.includes("אשראי")
    );

    if (rowHasCardHint) {
      values.forEach((text) => addMatches(text));
      if (candidates.length > 0) {
        return normalizeCardLast4(candidates[candidates.length - 1]);
      }
    }
  }

  for (const row of headerRows) {
    for (const cell of row) {
      const text = String(cell || "").trim();
      if (!text || text.includes("/") || text.includes(":")) continue;
      const match = text.match(/(?:מסתיים\s*ב-?|מסתיים\s*ב\s*-\s*|\b)(\d{4})(?:\s*-\s*|-\s*|$)/);
      if (match) {
        return normalizeCardLast4(match[1]);
      }
    }
  }

  return null;
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
    amountCharge: indexOf(["סכום חיוב", "סכום החיוב", "סכום בש\"ח", "סכום בשח", "סכום עסקה"]),
    originalAmount: indexOf(["סכום עסקה", "סכום העסקה", "סכום עסקה מקורי"]),
    typeRaw: indexOf(["סוג עסקה", "פירוט נוסף", "הערות"]),
    categoryRaw: indexOf(["קטגוריה"]),
    cardLast4: indexOf(["4 ספרות אחרונות של כרטיס האשראי"]),
    currency: indexOf(["מטבע חיוב", "מטבע"]),
  };

  if (map.txnDate === -1 || map.amountCharge === -1 || map.merchant === -1) {
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

    const sheetCardLast4 = extractCardLast4FromRows(rows) || normalizeCardLast4(fileCardLast4);
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
      const txnDate = toIsoDate(getValue(headerMap.txnDate));
      const postingDate = toIsoDate(getValue(headerMap.postingDate));
      if (!txnDate) continue;

      const cardLast4 =
        normalizeCardLast4(getValue(headerMap.cardLast4)) ||
        sheetCardLast4 ||
        normalizeCardLast4(fileCardLast4);
      const merchantValue = getValue(headerMap.merchant);
      const typeRawValue = getValue(headerMap.typeRaw);
      const categoryRawValue = getValue(headerMap.categoryRaw);
      const typeRaw = String(typeRawValue ?? "").trim() || null;
      const isInstallments = Boolean(
        typeRaw && (typeRaw.includes("תשלומים") || (typeRaw.includes("תשלום") && typeRaw.includes("מתוך")))
      );
      const originalAmount = isInstallments ? asNumber(getValue(headerMap.originalAmount)) : null;

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
        amountCharge: asNumber(getValue(headerMap.amountCharge)),
        originalAmount,
        currency: String(getValue(headerMap.currency) || "₪").trim(),
        raw,
      });
    }
  }

  return out;
}
