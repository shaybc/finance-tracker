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

function hasInstallmentNote(values) {
  const installmentRegex = /תשלום\s*\d+\s*מתוך\s*\d+/;
  return values.some((value) => installmentRegex.test(String(value ?? "")));
}

function findHeaderMap(row) {
  console.log("Finding header map for row:", row);
  const normalized = row.map(normalizeHeader);
  console.log("Normalized headers:", normalized);
  const pick = (options) => normalized.findIndex((v) => options.includes(v));

  const map = {
    txnDate: pick(["תאריךעסקה", "תאריךהעסקה"]),
    chargeDate: pick(["תאריךחיוב", "תאריךהחיוב"]),
    merchant: pick(["שםביתעסק", "ביתעסק", "שםביתהעסק"]),
    amountCharge: pick(["סכוםחיוב", "סכוםלחיוב"]),
    amountTxn: pick(["סכוםעסקה", "סכוםעסקהמקורי"]),
    typeRaw: pick(["סוגעסקה", "פירוטנוסף", "הערות"]),
    categoryRaw: pick(["ענף", "קטגוריה"]),
    cardLast4: pick(["4ספרותאחרונותשלכרטיסהאשראי"]),
  };

  if (map.txnDate < 0 || map.merchant < 0 || (map.amountCharge < 0 && map.amountTxn < 0)) {
    console.log("Required headers not found, returning null");
    return null;
  }

  console.log("Detected header map:", map);
  return map;
}

export function parseMax({ wb, fileCardLast4 }) {
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  console.log(`Parsing Max credit card statement with ${rows.length} rows`);

  const out = [];
  let currentHeaderMap = null;
  let currentHeaders = null;
  let chargeDate = null;

  // Attempt to find charge date from first 10 rows
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
  console.log(`Detected charge date: ${chargeDate}`);

  // Main parsing loop
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) {
      console.log(`Skipping empty row at line ${r + 1} since it has no data`);
      continue;
    }

    const headerMap = findHeaderMap(row);
    if (headerMap) {
      console.log(`Detected header row at line ${r + 1}:`, headerMap);
      currentHeaderMap = headerMap;
      currentHeaders = row.map((h) => String(h).replace(/\n/g, " ").trim());
      continue;
    }
    else console.log(`No header detected at line ${r + 1}`);

    if (!currentHeaderMap || !currentHeaders) continue;

    const obj = {};
    let empty = true;
    // Build raw object and check if row is empty
    for (let c = 0; c < currentHeaders.length; c++) {
      const key = currentHeaders[c] || `col_${c}`;
      const val = row[c];
      if (val !== "" && val != null) empty = false;
      obj[key] = val;
    }
    console.log(`Row is empty: ${empty}`);
    if (empty) continue;

    const typeRaw = currentHeaderMap.typeRaw >= 0 ? String(row[currentHeaderMap.typeRaw] || "").trim() || null : null;
    console.log(`Parsed typeRaw: ${typeRaw}`);

    const parsedTxnDate = toIsoDate(row[currentHeaderMap.txnDate]);
    let txnDate = parsedTxnDate;
    console.log(`Parsed txnDate: ${txnDate}`);

    const currentCardLast4 = currentHeaderMap.cardLast4 >= 0 ? normalizeCardLast4(row[currentHeaderMap.cardLast4]) : null;
    console.log(`Parsed card last 4 from row: ${currentCardLast4}`);

    const isInstallments = Boolean(
      (typeRaw && typeRaw.includes("תשלומים")) || hasInstallmentNote(Object.values(obj))
    );
    console.log(`Is installments: ${isInstallments}`);

    if (isInstallments) {
      if (chargeDate) txnDate = chargeDate;
      else if (currentHeaderMap.chargeDate >= 0) {
        const parsedChargeDate = toIsoDate(row[currentHeaderMap.chargeDate]);
        if (parsedChargeDate) txnDate = parsedChargeDate;
      }
    }
    console.log(`Final txnDate used: ${txnDate}`);
    if (!txnDate) continue;

    const amountValue =
      currentHeaderMap.amountCharge >= 0
        ? row[currentHeaderMap.amountCharge]
        : row[currentHeaderMap.amountTxn];
    console.log(`Parsed amountValue: ${amountValue}`);

    const amountTxnValue =
      currentHeaderMap.amountTxn >= 0 ? row[currentHeaderMap.amountTxn] : null;
    console.log(`Parsed amountTxnValue: ${amountTxnValue}`);

    out.push({
      source: formatCardSource(currentCardLast4),
      accountRef: null,
      cardLast4: currentCardLast4,
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
