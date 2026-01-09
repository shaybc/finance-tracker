import { DateTime } from "luxon";

function excelSerialToIsoDate(serial) {
  // Excel 1900 date system: day 0 == 1899-12-30
  const base = DateTime.fromObject(
    { year: 1899, month: 12, day: 30 },
    { zone: "Asia/Jerusalem" }
  );
  const days = Math.trunc(serial);
  const dt = base.plus({ days });
  return dt.isValid ? dt.toISODate() : null;
}

function localIsoDateFromDateParts(year, month, day) {
  const dt = DateTime.fromObject({ year, month, day }, { zone: "Asia/Jerusalem" });
  return dt.isValid ? dt.toISODate() : null;
}

export function toIsoDate(value) {
  if (value == null || value === "") return null;

  // Excel Date -> JS Date (xlsx usually returns Date objects for date cells)
  if (value instanceof Date) {
    return localIsoDateFromDateParts(
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate()
    );
  }

  // Excel numeric serial dates (or sometimes YYYYMMDD numbers)
  if (typeof value === "number" && Number.isFinite(value)) {
    const asInt = Math.trunc(value);
    const s8 = String(asInt);
    if (/^\d{8}$/.test(s8)) {
      const ymd = DateTime.fromFormat(s8, "yyyyMMdd", { zone: "Asia/Jerusalem" });
      if (ymd.isValid) return ymd.toISODate();
    }

    // Typical Excel serial day numbers for modern dates ~ 30,000 - 60,000
    if (asInt > 20000 && asInt < 100000) {
      const iso = excelSerialToIsoDate(value);
      if (iso) return iso;
    }
  }

  const s = String(value).trim();

  // Sometimes numbers are strings (e.g. "45233" or "20260105")
  if (/^\d{8}$/.test(s)) {
    const ymd = DateTime.fromFormat(s, "yyyyMMdd", { zone: "Asia/Jerusalem" });
    if (ymd.isValid) return ymd.toISODate();
  }
  if (/^\d{5}$/.test(s) || /^\d{6}$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) {
      const iso = excelSerialToIsoDate(n);
      if (iso) return iso;
    }
  }

  // Common Israeli exports: DD-MM-YYYY
  const dmy = DateTime.fromFormat(s, "dd-MM-yyyy", { zone: "Asia/Jerusalem" });
  if (dmy.isValid) return dmy.toISODate();

  // Also common: DD.MM.YYYY
  const dmyDot = DateTime.fromFormat(s, "dd.MM.yyyy", { zone: "Asia/Jerusalem" });
  if (dmyDot.isValid) return dmyDot.toISODate();

  // Sometimes two-digit year
  const dmyDot2 = DateTime.fromFormat(s, "dd.MM.yy", { zone: "Asia/Jerusalem" });
  if (dmyDot2.isValid) return dmyDot2.toISODate();

  // Sometimes: YYYY-MM-DD
  const iso = DateTime.fromISO(s, { zone: "Asia/Jerusalem" });
  if (iso.isValid) return iso.toISODate();

  // Fallback: try dd/MM/yyyy
  const dmy2 = DateTime.fromFormat(s, "dd/MM/yyyy", { zone: "Asia/Jerusalem" });
  if (dmy2.isValid) return dmy2.toISODate();

  // And dd/MM/yy
  const dmy3 = DateTime.fromFormat(s, "dd/MM/yy", { zone: "Asia/Jerusalem" });
  if (dmy3.isValid) return dmy3.toISODate();

  return null;
}

export function toIsoDateTimeNow() {
  return DateTime.now().toISO();
}

export function yyyymmFromIsoDate(isoDate) {
  if (!isoDate) return "unknown";
  const dt = DateTime.fromISO(isoDate);
  return dt.isValid ? dt.toFormat("yyyy-MM") : "unknown";
}
