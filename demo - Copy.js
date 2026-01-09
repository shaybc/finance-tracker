import XLSX from "xlsx";
import fs from "fs";

// Simplified date parser for debugging
function parseExcelDate(value) {
  console.log("\n--- Parsing value ---");
  console.log("Raw value:", value);
  console.log("Type:", typeof value);
  console.log("instanceof Date:", value instanceof Date);

  if (value instanceof Date) {
    console.log("\nDate object details:");
    console.log("  toISOString():", value.toISOString());
    console.log("  toUTCString():", value.toUTCString());
    console.log("  toString():", value.toString());
    
    console.log("\nLocal methods (system timezone):");
    console.log("  getFullYear():", value.getFullYear());
    console.log("  getMonth():", value.getMonth(), "(0=Jan)");
    console.log("  getDate():", value.getDate());
    console.log("  getHours():", value.getHours());
    
    console.log("\nUTC methods:");
    console.log("  getUTCFullYear():", value.getUTCFullYear());
    console.log("  getUTCMonth():", value.getUTCMonth(), "(0=Jan)");
    console.log("  getUTCDate():", value.getUTCDate());
    console.log("  getUTCHours():", value.getUTCHours());

    // Show what ISO date would be with each method
    const localISO = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    const utcISO = `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
    
    console.log("\nFormatted dates:");
    console.log("  Using local methods:", localISO);
    console.log("  Using UTC methods:", utcISO);
    
    return { localISO, utcISO };
  }

  if (typeof value === "number") {
    console.log("\nNumeric value - Excel serial date");
    const msPerDay = 86400 * 1000;
    const unixTime = (value - 25569) * msPerDay;
    const jsDate = new Date(unixTime);
    console.log("  Excel serial:", value);
    console.log("  Converted to JS Date:", jsDate.toISOString());
    return parseExcelDate(jsDate);
  }

  console.log("Not a Date or Number - cannot parse");
  return null;
}

function debugExcelDates(filePath) {
  console.log("=".repeat(80));
  console.log("EXCEL DATE PARSER DEBUG");
  console.log("=".repeat(80));
  console.log("\nFile:", filePath);
  console.log("System timezone offset (minutes from UTC):", new Date().getTimezoneOffset());
  console.log("(Negative means ahead of UTC)");

  // Read the workbook
  const fileBuffer = fs.readFileSync(filePath);
  
  console.log("\n" + "=".repeat(80));
  console.log("TEST 1: Reading with raw: true (default behavior)");
  console.log("=".repeat(80));
  
  const wb = XLSX.read(fileBuffer, { type: "buffer", cellDates: false, raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });

  // Find header row
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const row = rows[i].map((x) => String(x).trim());
    if (row.includes("תאריך") && row.includes("תיאור התנועה")) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.log("\n❌ Header row not found!");
    return;
  }

  const headers = rows[headerIdx].map((h) => String(h).trim());
  const dateColIdx = headers.indexOf("תאריך");

  console.log("\n✓ Found header at row", headerIdx);
  console.log("✓ Date column index:", dateColIdx);
  console.log("\nProcessing first 5 date rows:\n");

  let count = 0;
  for (let r = headerIdx + 1; r < rows.length && count < 5; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const rawDateValue = row[dateColIdx];
    if (!rawDateValue) continue;

    console.log("=".repeat(80));
    console.log(`ROW ${r} - Date cell #${count + 1}`);
    parseExcelDate(rawDateValue);
    count++;
  }

  console.log("\n" + "=".repeat(80));
  console.log("TEST 2: Reading with cellDates: true");
  console.log("=".repeat(80));
  
  const wb2 = XLSX.read(fileBuffer, { type: "buffer", cellDates: true });
  const sheet2 = wb2.Sheets[wb2.SheetNames[0]];
  const rows2 = XLSX.utils.sheet_to_json(sheet2, { header: 1, defval: "", raw: true });

  console.log("\nProcessing first 3 date rows:\n");
  
  count = 0;
  for (let r = headerIdx + 1; r < rows2.length && count < 3; r++) {
    const row = rows2[r];
    if (!row || row.length === 0) continue;

    const rawDateValue = row[dateColIdx];
    if (!rawDateValue) continue;

    console.log("=".repeat(80));
    console.log(`ROW ${r} - Date cell #${count + 1}`);
    parseExcelDate(rawDateValue);
    count++;
  }

  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY & RECOMMENDATIONS");
  console.log("=".repeat(80));
  console.log("\nIf you see dates are off by one day, the issue is likely:");
  console.log("1. Excel dates are stored as UTC midnight (00:00:00)");
  console.log("2. Your code uses getFullYear(), getMonth(), getDate() - these use LOCAL time");
  console.log("3. When converting UTC to local time, if you're ahead of UTC, the date goes back");
  console.log("\nFIX: Use getUTCFullYear(), getUTCMonth(), getUTCDate() instead!");
  console.log("This ensures you read the date components as they are in UTC.");
}

// Usage
const excelPath = process.argv[2] || "./bank_example.xlsx";

try {
  debugExcelDates(excelPath);
} catch (error) {
  console.error("\n❌ Error:", error.message);
  console.log("\nUsage: node demo.js <path-to-excel-file>");
}