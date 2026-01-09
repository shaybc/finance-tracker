import XLSX from "xlsx";
import { toIsoDate } from "../../utils/date.js";

function asNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/,/g, "").replace(/₪/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractAccountRef(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i] || [];
    const joined = row.map((x) => String(x)).join(" ");
    const m = joined.match(/חשבון:\s*([0-9]{6,})/);
    if (m) return m[1];
  }
  return null;
}

export function parseBank({ wb }) {
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });

  const accountRef = extractAccountRef(rows);

  // Find header row containing "תאריך" and "תיאור התנועה"
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const row = rows[i].map((x) => String(x).trim());
    if (row.includes("תאריך") && row.includes("תיאור התנועה")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const headers = rows[headerIdx].map((h) => String(h).trim());

  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    // Stop if another header appears
    if (String(row[0]).trim() === "תאריך" && String(row[2]).includes("תיאור")) break;

    const obj = {};
    let empty = true;
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c] || `col_${c}`;
      const val = row[c];
      if (val !== "" && val != null) empty = false;
      obj[key] = val;
    }
    if (empty) continue;

    const txnDate = toIsoDate(obj["תאריך"]);
    if (!txnDate) continue;

    const postingDate = toIsoDate(obj["יום ערך"]);

    out.push({
      source: "bank",
      accountRef,
      txnDate,
      postingDate,
      merchant: null,
      description: String(obj["תיאור התנועה"] || "").trim() || null,
      categoryRaw: null,
      typeRaw: null,
      amountSigned: asNumber(obj["₪ זכות/חובה"]) ?? asNumber(obj["₪ זכות/חובה "]) ?? asNumber(obj["₪ זכות/חובה ב "]),
      balance: asNumber(obj["₪ יתרה"]) ?? asNumber(obj["₪ יתרה "]) ?? asNumber(obj["₪ יתרה משוערת "]),
      currency: "₪",
      raw: obj,
    });
  }

  return out;
}
