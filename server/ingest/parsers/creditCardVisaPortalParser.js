import XLSX from "xlsx";
import { toIsoDate } from "../../utils/date.js";
import { formatCardSource, normalizeCardLast4 } from "../../utils/source.js";

function asNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/,/g, "").replace(/₪/g, "").replace(/"/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseVisaPortal({ wb, fileCardLast4 }) {
  const out = [];
  for (const sheetName of wb.SheetNames) {
    if (!sheetName.includes("עסקאות")) continue;

    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });

    // Find header row that contains 'תאריך עסקה' and 'סכום חיוב'
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const row = rows[i].map((x) => String(x).trim());
      const hasTxnDate = row.includes("תאריך עסקה") || row.includes("תאריך העסקה");
      const hasCharge = row.includes("סכום חיוב") || row.includes("סכום החיוב");
      const hasMerchant = row.includes("שם בית העסק");
      if (hasTxnDate && hasCharge && hasMerchant) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) continue;

    const headers = rows[headerIdx].map((h) => String(h).trim());
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const obj = {};
      let empty = true;
      for (let c = 0; c < headers.length; c++) {
        const key = headers[c] || `col_${c}`;
        const val = row[c];
        if (val !== "" && val != null) empty = false;
        obj[key] = val;
      }
      if (empty) continue;

      const txnDate = toIsoDate(obj["תאריך עסקה"] ?? obj["תאריך העסקה"]);
      const postingDate = toIsoDate(obj["תאריך חיוב"] ?? obj["תאריך החיוב"]);
      if (!txnDate) continue;

      const cardLast4 =
        normalizeCardLast4(obj["4 ספרות אחרונות של כרטיס האשראי"]) || normalizeCardLast4(fileCardLast4);
      const typeRaw = String(obj["סוג עסקה"] ?? obj["פירוט נוסף"] ?? "").trim() || null;
      const isInstallments = Boolean(typeRaw && (typeRaw.includes("תשלומים") || (typeRaw.includes("תשלום") && typeRaw.includes("מתוך"))));
      const originalAmount = isInstallments
        ? asNumber(obj["סכום עסקה"] ?? obj["סכום העסקה"] ?? obj["סכום עסקה מקורי"])
        : null;

      out.push({
        source: formatCardSource(cardLast4),
        sheet: sheetName,
        cardLast4,
        txnDate,
        postingDate,
        merchant: String(obj["שם בית העסק"] || "").trim() || null,
        categoryRaw: String(obj["קטגוריה"] || "").trim() || null,
        typeRaw,
        amountCharge: asNumber(obj["סכום חיוב"] ?? obj["סכום החיוב"]),
        originalAmount,
        currency: String(obj["מטבע חיוב"] || "₪").trim(),
        raw: obj,
      });
    }
  }

  return out;
}
