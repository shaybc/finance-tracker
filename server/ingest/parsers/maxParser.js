import XLSX from "xlsx";
import { toIsoDate } from "../../utils/date.js";

function asNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/,/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseMax({ wb }) {
  const out = [];
  for (const sheetName of wb.SheetNames) {
    if (!sheetName.includes("עסקאות")) continue;

    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });

    // Find header row that contains 'תאריך עסקה' and 'סכום חיוב'
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const row = rows[i].map((x) => String(x).trim());
      if (row.includes("תאריך עסקה") && row.includes("סכום חיוב")) {
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

      const txnDate = toIsoDate(obj["תאריך עסקה"]);
      const postingDate = toIsoDate(obj["תאריך חיוב"]);
      if (!txnDate) continue;

      out.push({
        source: "max",
        sheet: sheetName,
        cardLast4: String(obj["4 ספרות אחרונות של כרטיס האשראי"] || "").trim() || null,
        txnDate,
        postingDate,
        merchant: String(obj["שם בית העסק"] || "").trim() || null,
        categoryRaw: String(obj["קטגוריה"] || "").trim() || null,
        typeRaw: String(obj["סוג עסקה"] || "").trim() || null,
        amountCharge: asNumber(obj["סכום חיוב"]),
        currency: String(obj["מטבע חיוב"] || "₪").trim(),
        raw: obj,
      });
    }
  }

  return out;
}
