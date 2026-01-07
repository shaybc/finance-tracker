import XLSX from "xlsx";

export function detectSource(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheetNames = wb.SheetNames || [];

  const first = wb.Sheets[sheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(first, { header: 1, defval: "" });

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

  if (flat.includes("סכום חיוב") || (flat.includes("סכום") && flat.includes("ענף") && flat.includes("שם בית"))) {
    return { source: "max", wb, sheetNames };
  }

  if (flat.includes("מפתח דיסקונט") || flat.includes("תאריך חיוב") || sheetNames.some((s) => s.includes("עסקאות"))) {
    return { source: "visa_portal", wb, sheetNames };
  }

  return { source: "unknown", wb, sheetNames };
}
