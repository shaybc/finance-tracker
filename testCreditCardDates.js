import { DateTime } from "luxon";

function testDateParsing(dateString) {
  console.log("\n" + "=".repeat(80));
  console.log("Testing:", dateString);
  console.log("=".repeat(80));
  
  // Method 1: Using Luxon with timezone (your current code)
  const dmy1 = DateTime.fromFormat(dateString, "dd-MM-yyyy", { zone: "Asia/Jerusalem" });
  console.log("\nMethod 1: Luxon with Asia/Jerusalem timezone");
  console.log("  Valid:", dmy1.isValid);
  console.log("  Result:", dmy1.toISODate());
  console.log("  Full ISO:", dmy1.toISO());
  
  // Method 2: Using Luxon without timezone
  const dmy2 = DateTime.fromFormat(dateString, "dd-MM-yyyy");
  console.log("\nMethod 2: Luxon without timezone");
  console.log("  Valid:", dmy2.isValid);
  console.log("  Result:", dmy2.toISODate());
  console.log("  Full ISO:", dmy2.toISO());
  
  // Method 3: Parse and recreate in UTC
  const parts = dateString.match(/(\d+)-(\d+)-(\d+)/);
  if (parts) {
    const day = parseInt(parts[1], 10);
    const month = parseInt(parts[2], 10);
    const year = parseInt(parts[3], 10);
    
    console.log("\nMethod 3: Parse manually and use UTC");
    console.log("  Day:", day, "Month:", month, "Year:", year);
    
    const dt = DateTime.utc(year, month, day);
    console.log("  Result:", dt.toISODate());
    console.log("  Full ISO:", dt.toISO());
  }
}

// Test with the dates from your Excel file
testDateParsing("25-09-2025");
testDateParsing("30-09-2025");
testDateParsing("02-10-2025");
testDateParsing("05-10-2025");

// Also test a date that might have DST issues
testDateParsing("02-08-2024");