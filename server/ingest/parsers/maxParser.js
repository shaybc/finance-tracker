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
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });

  // header row contains "שם בית עסק" and "סכום"
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const row = rows[i].map((x) => String(x).trim());
    if (row.some((v) => v.includes("שם בית עסק")) && row.some((v) => v.includes("סכום"))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const headers = rows[headerIdx].map((h) => String(h).replace(/\n/g, " ").trim());

  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

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
    if (!txnDate) continue;

    out.push({
      source: "max",
      accountRef: null,
      txnDate,
      postingDate: null,
      merchant: String(obj["שם בית עסק"] || "").trim() || null,
      categoryRaw: String(obj["ענף"] || "").trim() || null,
      typeRaw: String(obj["סוג עסקה"] || "").trim() || null,
      amountCharge: asNumber(obj["סכום חיוב"]),
      currency: "₪",
      raw: obj,
    });
  }

  return out;
}
