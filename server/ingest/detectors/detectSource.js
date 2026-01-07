import XLSX from "xlsx";

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/[^0-9A-Za-zא-ת]/g, "")
    .trim();
}

function hasMaxHeader(rows) {
  for (const row of rows) {
    if (!row || row.length === 0) continue;
    const normalized = row.map(normalizeHeader);
    const hasDate = normalized.includes("תאריךעסקה") || normalized.includes("תאריך");
    const hasMerchant = normalized.includes("שםביתעסק") || normalized.includes("ביתעסק");
    const hasAmount =
      normalized.includes("סכוםחיוב") ||
      normalized.includes("סכוםלחיוב") ||
      normalized.includes("סכוםעסקה") ||
      normalized.includes("סכום");
    if (hasDate && hasMerchant && hasAmount) return true;
  }
  return false;
}

export function detectSource(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheetNames = wb.SheetNames || [];

  const first = wb.Sheets[sheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(first, { header: 1, defval: "" });
  const headerScan = rows.slice(0, 60);

  // Normalize whitespace (including embedded newlines that sometimes exist in header cells)
  const flatRaw = rows
    .slice(0, 30)
    .flat()
    .map((v) => String(v ?? "").trim())
    .join(" | ");

  const flat = flatRaw.replace(/\s+/g, " ").trim();

  if (flat.includes("₪ זכות/חובה") || flat.includes("תיאור התנועה") || sheetNames.some((s) => s.includes("עובר ושב"))) {
    return { source: "bank", wb, sheetNames };
  }

  if (
    flat.includes("סכום חיוב") ||
    (flat.includes("סכום") && flat.includes("ענף") && flat.includes("שם בית")) ||
    hasMaxHeader(headerScan)
  ) {
    return { source: "max", wb, sheetNames };
  }

  if (flat.includes("מפתח דיסקונט") || flat.includes("תאריך חיוב") || sheetNames.some((s) => s.includes("עסקאות"))) {
    return { source: "visa_portal", wb, sheetNames };
  }

  return { source: "unknown", wb, sheetNames };
}
