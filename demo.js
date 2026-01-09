import XLSX from "xlsx";
import fs from "fs";

function analyzeExcelFile(filePath) {
  console.log("=".repeat(80));
  console.log("ANALYZING EXCEL FILE");
  console.log("=".repeat(80));
  console.log("\nFile:", filePath);
  
  const fileBuffer = fs.readFileSync(filePath);
  
  // Test with cellDates: false (correct)
  console.log("\n" + "=".repeat(80));
  console.log("TEST 1: cellDates: false (CORRECT WAY)");
  console.log("=".repeat(80));
  
  const wb1 = XLSX.read(fileBuffer, { type: "buffer", cellDates: false });
  
  console.log("\nSheet names:", wb1.SheetNames);
  
  for (const sheetName of wb1.SheetNames) {
    const sheet = wb1.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
    
    console.log(`\n--- Sheet: ${sheetName} ---`);
    console.log("Total rows:", rows.length);
    
    // Find header row
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const row = rows[i] || [];
      const rowStr = row.map((x) => String(x).trim()).join("|");
      if (rowStr.includes("תאריך")) {
        headerIdx = i;
        console.log(`Found header at row ${i}:`, row.slice(0, 5));
        break;
      }
    }
    
    if (headerIdx >= 0 && rows[headerIdx + 1]) {
      console.log("\nFirst 3 data rows:");
      for (let r = headerIdx + 1; r < Math.min(headerIdx + 4, rows.length); r++) {
        const row = rows[r];
        if (!row || row.length === 0) continue;
        
        console.log(`\nRow ${r}:`);
        // Show first few cells
        for (let c = 0; c < Math.min(row.length, 5); c++) {
          const val = row[c];
          console.log(`  Col ${c}: ${JSON.stringify(val)} (${typeof val})`);
          
          if (val instanceof Date) {
            console.log(`    -> UTC: ${val.toISOString()}`);
            console.log(`    -> getUTCDate(): ${val.getUTCDate()}`);
          } else if (typeof val === 'number' && val > 20000 && val < 100000) {
            // Looks like Excel serial
            const msPerDay = 86400 * 1000;
            const unixTime = (val - 25569) * msPerDay;
            const jsDate = new Date(unixTime);
            console.log(`    -> Excel serial -> ${jsDate.toISOString()}`);
          }
        }
      }
    }
  }
  
  // Test with cellDates: true (incorrect - what you had before)
  console.log("\n" + "=".repeat(80));
  console.log("TEST 2: cellDates: true (INCORRECT - OLD WAY)");
  console.log("=".repeat(80));
  
  const wb2 = XLSX.read(fileBuffer, { type: "buffer", cellDates: true });
  
  for (const sheetName of wb2.SheetNames) {
    const sheet = wb2.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
    
    console.log(`\n--- Sheet: ${sheetName} ---`);
    
    // Find header row
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const row = rows[i] || [];
      const rowStr = row.map((x) => String(x).trim()).join("|");
      if (rowStr.includes("תאריך")) {
        headerIdx = i;
        break;
      }
    }
    
    if (headerIdx >= 0 && rows[headerIdx + 1]) {
      console.log("\nFirst data row (dates only):");
      const row = rows[headerIdx + 1];
      
      for (let c = 0; c < Math.min(row.length, 5); c++) {
        const val = row[c];
        
        if (val instanceof Date) {
          console.log(`  Col ${c}: ${val.toISOString()}`);
          console.log(`    -> getUTCDate(): ${val.getUTCDate()}`);
          console.log(`    -> getDate(): ${val.getDate()}`);
        }
      }
    }
  }
  
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log("\nIf TEST 1 shows correct dates but TEST 2 shows dates off by 1 day,");
  console.log("then the fix is working correctly!");
  console.log("\nMake sure processFile.js uses: cellDates: false");
}

const excelPath = process.argv[2];
if (!excelPath) {
  console.log("Usage: node demo.js <path-to-excel-file>");
  process.exit(1);
}

try {
  analyzeExcelFile(excelPath);
} catch (error) {
  console.error("\n❌ Error:", error.message);
  console.error(error.stack);
}