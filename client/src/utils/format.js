export function formatILS(amountSigned) {
  const n = Number(amountSigned || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${abs.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`;
}

export function isoToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function isoMonthStart() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}-01`;
}

export function formatDateDMY(dateValue) {
  if (!dateValue) {
    return dateValue;
  }

  if (typeof dateValue === "string") {
    const [year, month, day] = dateValue.split("-");
    if (year && month && day) {
      return `${day}/${month}/${year}`;
    }
  }

  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return dateValue;
  }

  const dd = String(parsed.getDate()).padStart(2, "0");
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const yyyy = parsed.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
