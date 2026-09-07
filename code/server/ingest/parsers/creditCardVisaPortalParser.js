import XLSX from "xlsx";
import { DateTime } from "luxon";
import { toIsoDate } from "../../utils/date.js";
import { logger } from "../../utils/logger.js";
import { formatCardSource, normalizeCardLast4 } from "../../utils/source.js";

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/[״"']/g, "")
    .replace(/[^0-9A-Za-zא-ת]/g, "")
    .trim();
}

function asNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/,/g, "").replace(/[₪$€£\s\u200e\u200f]/g, "").replace(/"/g, "").trim();
  if (!s || !/^[+-]?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isPendingTransaction(values) {
  return values.some((value) => String(value ?? "").includes("עסקה בקליטה"));
}

export function isUtf16TabDelimitedVisaExport(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const hasUtf16LeBom = buffer[0] === 0xff && buffer[1] === 0xfe;
  if (!hasUtf16LeBom) return false;
  const text = buffer.toString("utf16le", 0, Math.min(buffer.length, 8192));
  return text.includes("\t") && text.includes("תאריך העסקה") && text.includes("סכום החיוב");
}

export function parseUtf16TabDelimitedRows(buffer) {
  return readVisaTextRows(buffer);
}

/** Read a Visa text export without interpreting amounts or dates as Excel cells. */
export function readVisaTextRows(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if ((buffer[0] === 0x50 && buffer[1] === 0x4b) || (buffer[0] === 0xd0 && buffer[1] === 0xcf)) return null;
  const encodings = buffer[0] === 0xff && buffer[1] === 0xfe ? ["utf-16le"]
    : buffer[0] === 0xfe && buffer[1] === 0xff ? ["utf-16be"] : ["utf-8", "utf-16le", "utf-16be"];
  for (const encoding of encodings) {
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(buffer).replace(/^\uFEFF/, ""); } catch { continue; }
    if (!/לכרטיס\s+(?:ויזה|דיינרס)/.test(text) || !/תאריך\s*(?:ה)?עסקה/.test(text) || !/סכום\s*(?:ה)?חיוב/.test(text)) continue;
    const separator = text.includes("\t") ? "\t" : ",";
    const workbook = XLSX.read(text, { type: "string", raw: true, FS: separator });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: "", raw: true, blankrows: true });
    rows.sourceLines = [1];
    let quoted = false;
    let fieldStart = true;
    let line = 1;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"' && (quoted || fieldStart)) {
        if (quoted && text[i + 1] === '"') i++;
        else quoted = !quoted;
      }
      if (char === "\n") {
        line++;
        if (!quoted) rows.sourceLines.push(line);
      }
      fieldStart = !quoted && (char === separator || char === "\n" || char === "\r");
    }
    return rows;
  }
  return null;
}

function extractCardLast4FromRows(rows) {
  const patterns = [
    /המסתיים\s+(?:ב-?|בספרות\s+)(\d{4})/,
    /לכרטיס\s\W+המסתיים ב-(\d{4})/,
    /לכרטיס\sויזה\s(\d{4})/,
    /לכרטיס\sדיינרס\s(\d{4})/,
  ];

  for (const row of rows) {
    // join row cells if it's an array
    const rowStr = Array.isArray(row) ? row.join(" ") : row;
    if (!rowStr || typeof rowStr !== 'string') continue;
    
    // Try each pattern
    for (const pattern of patterns) {
      const match = rowStr.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
  }
  
  return null; // Return null if no card number found
}

function extractChargeDate(rows, quiet = false) {
  const patterns = [
    /לתאריך חיוב\s+(\d{1,2}\/\d{1,2}\/\d{4})/,
    /לתאריך חיוב\s+(\d{1,2}\/\d{4})/,
    /עסקאות לחיוב ב-\s*(\d{1,2}\/\d{1,2}\/\d{4})/
  ];

  for (const row of rows) {
    // join row cells if it's an array
    const rowStr = Array.isArray(row) ? row.join(" ") : row;
    if (!rowStr || typeof rowStr !== 'string') continue;
    
    // Try each pattern
    for (const pattern of patterns) {
      const match = rowStr.match(pattern);
      if (!quiet) console.log(`Checking row for charge date: "${rowStr}", pattern: ${pattern}, match: ${match}`);
      if (match && match[1]) {
        return match[1];
      }
    }
  }
  
  return null; // Return null if no charge date found
}

function detectHeaderMap(row) {
  const normalized = row.map(normalizeHeader);
  const indexOf = (aliases) => {
    const normalizedAliases = aliases.map(normalizeHeader);
    return normalized.findIndex((value) => normalizedAliases.includes(value));
  };

  const map = {
    txnDate: indexOf(["תאריך עסקה", "תאריך העסקה"]),
    postingDate: indexOf(["תאריך חיוב", "תאריך החיוב", "מועד חיוב"]),
    merchant: indexOf(["שם בית העסק", "שם בית עסק"]),
    chargeAmount: indexOf(["סכום חיוב", "סכום החיוב", "סכום בש\"ח", "סכום בשח"]),
    originalDealAmount: indexOf(["סכום עסקה", "סכום העסקה", "סכום עסקה מקורי"]),
    typeRaw: indexOf(["סוג עסקה", "פירוט נוסף", "הערות"]),
    categoryRaw: indexOf(["קטגוריה"]),
    currency: indexOf(["מטבע חיוב", "מטבע"]),
    chargeDate: indexOf(["מועדחיוב", "מועדהחיוב"]),
  };

  if (map.txnDate === -1 || map.chargeAmount === -1 || map.merchant === -1) {
    return null;
  }

  return map;
}

function rowsFromSheet(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true }).map((row) => {
    if (row.length === 1 && typeof row[0] === "string" && row[0].includes("\t")) {
      return row[0].split("\t").map((cell) => cell.trim());
    }
    return row;
  });
}

export function parseVisaPortal({ wb, fileCardLast4, textRows = null, fileName = "", audit = null, quiet = false }) {
  const out = [];
  const sheetInputs = [];

  if (textRows) {
    sheetInputs.push({ sheetName: "Sheet1", rows: textRows });
  } else {
    const sheetNames = wb.SheetNames || [];
    const targetSheets = sheetNames.filter((name) => name.includes("עסקאות"));
    if (targetSheets.length === 0 && sheetNames[0]) {
      targetSheets.push(sheetNames[0]);
    }

    for (const sheetName of targetSheets) {
      sheetInputs.push({ sheetName, rows: rowsFromSheet(wb.Sheets[sheetName]) });
    }
  }

  for (const { sheetName, rows } of sheetInputs) {
    const cardLast4 = extractCardLast4FromRows(rows) || normalizeCardLast4(fileCardLast4);
    const headerChargeDate = extractChargeDate(rows, quiet);
    const excelChargeDate = toIsoDate(headerChargeDate);
    const monthMatch = headerChargeDate?.match(/^(\d{1,2})\/(\d{4})$/);
    const headerMonth = monthMatch ? `${monthMatch[2]}-${monthMatch[1].padStart(2, "0")}` : excelChargeDate?.slice(0, 7);
    const fileMonthMatch = fileName.match(/(?:^|[-_ ])(\d{1,2})[.](\d{4})(?:__[^.]*)?\.[^.]+$/);
    const fileMonth = fileMonthMatch ? `${fileMonthMatch[2]}-${fileMonthMatch[1].padStart(2, "0")}` : null;
    const statementMonth = headerMonth || fileMonth;
    if (statementMonth && !DateTime.fromISO(`${statementMonth}-01`).isValid) throw new Error(`Invalid Visa billing month: ${statementMonth}`);
    if (headerMonth && fileMonth && headerMonth !== fileMonth) throw new Error(`Visa billing month conflicts with filename: ${headerMonth} / ${fileMonth}`);
    if (out.statementMonth && statementMonth && out.statementMonth !== statementMonth) throw new Error("Multiple Visa billing months in one file");
    out.statementMonth = statementMonth || out.statementMonth || null;
    if (audit) { audit.rows ??= []; audit.totals ??= []; audit.issues ??= []; }

    let headerMap = null;
    let headerLabels = null;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const detectedHeader = detectHeaderMap(row);
      if (detectedHeader) {
        headerMap = detectedHeader;
        headerLabels = row.map((header) => String(header ?? "").replace(/\n/g, " ").trim());
        continue;
      }
      if (!headerMap) continue;

      if (row.every((cell) => cell == null || cell === "")) continue;
      if (row.some((cell) => String(cell || "").includes("סה\"כ"))) {
        const total = asNumber(row[headerMap.chargeAmount]);
        if (audit && total != null) audit.totals.push({ sheet: sheetName, sourceRow: r + 1, amount: total });
        continue;
      }

      const getValue = (idx) => (idx != null && idx >= 0 ? row[idx] : null);
      let txnDate = toIsoDate(getValue(headerMap.txnDate));
      const postingDate = toIsoDate(getValue(headerMap.postingDate)) ? toIsoDate(getValue(headerMap.postingDate)) : excelChargeDate;
      if (!txnDate) {
        if (audit && getValue(headerMap.merchant) && getValue(headerMap.txnDate)) audit.issues.push({ sourceRow: r + 1, reason: "invalid_transaction_date" });
        continue;
      }
      const purchaseDate = txnDate;

      const merchantValue = getValue(headerMap.merchant);
      const typeRawValue = getValue(headerMap.typeRaw);
      const categoryRawValue = getValue(headerMap.categoryRaw);
      const typeRaw = String(typeRawValue ?? "").trim() || null;
      const chargeAmountValue = getValue(headerMap.chargeAmount);
      const amountCharge = asNumber(chargeAmountValue);
      const skipReason = isPendingTransaction(row) ? "pending" : String(chargeAmountValue ?? "").trim() === "" ? "blank_charge" : amountCharge == null ? "invalid_charge" : amountCharge === 0 ? "zero_charge" : null;
      const chargeDate = toIsoDate(getValue(headerMap.chargeDate)) ? toIsoDate(getValue(headerMap.chargeDate)) : excelChargeDate;
      if (!quiet) console.log(`##!!##!!> chargeDate value: ${getValue(headerMap.chargeDate)}, parsed chargeDate: ${chargeDate}, excelChargeDate: ${excelChargeDate}`);
      const installmentText = row.map((value) => String(value ?? "")).join(" ");
      const installmentPair = installmentText.match(/תשלום\s+(\d+)\s+מתוך\s+(\d+)/);
      const isInstallments = Boolean(
        installmentPair || (typeRaw && (typeRaw.includes("תשלומים") || (typeRaw.includes("תשלום") && typeRaw.includes("מתוך"))))
      );
      const exactChargeDate = toIsoDate(getValue(headerMap.postingDate)) || chargeDate;
      let dateDerived = false;
      if (isInstallments) {
        if (exactChargeDate) txnDate = exactChargeDate;
        else if (statementMonth) {
          const month = DateTime.fromISO(`${statementMonth}-01`);
          txnDate = month.set({ day: Math.min(Number(purchaseDate.slice(-2)), month.daysInMonth) }).toISODate();
          dateDerived = true;
        } else if (!skipReason) throw new Error(`Missing Visa billing period for installment at row ${r + 1}`);
      }

      const raw = {};
      if (headerLabels) {
        for (let c = 0; c < headerLabels.length; c++) {
          const key = headerLabels[c] || `col_${c}`;
          raw[key] = row[c];
        }
      } else {
        Object.entries(headerMap).forEach(([key, idx]) => {
          if (idx != null && idx >= 0) {
            raw[key] = row[idx];
          }
        });
      }

      raw._visa = {
        version: 2, statementMonth: statementMonth || exactChargeDate?.slice(0, 7) || null,
        originalTxnDate: purchaseDate, originalAmount: asNumber(getValue(headerMap.originalDealAmount)),
        isInstallment: isInstallments, installmentCurrent: installmentPair ? Number(installmentPair[1]) : null,
        installmentTotal: installmentPair ? Number(installmentPair[2]) : null,
        sourceSheet: sheetName, sourceRow: r + 1,
        sourceLine: textRows ? (textRows.sourceLines?.[r] || r + 1) : null, dateDerived,
      };
      const record = {
        source: formatCardSource(cardLast4),
        sheet: sheetName,
        cardLast4,
        txnDate,
        postingDate: exactChargeDate || postingDate,
        originalTxnDate: isInstallments ? purchaseDate : null,
        merchant: String(merchantValue || "").trim() || null,
        categoryRaw: String(categoryRawValue || "").trim() || null,
        typeRaw,
        amountCharge,
        originalAmount: asNumber(getValue(headerMap.originalDealAmount)),
        currency: String(getValue(headerMap.currency) || "₪").trim(),
        raw,
      };
      if (audit) audit.rows.push({ record, skipReason });
      if (skipReason === "invalid_charge") throw new Error(`Invalid Visa charge amount at row ${r + 1}: ${chargeAmountValue}`);
      if (skipReason) continue;
      out.push(record);
    }
  }

  return out;
}
