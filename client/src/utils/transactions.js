export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
export const PAGE_SIZE_PREFERENCE_STORAGE_KEY = "transactions.pageSize.preference";

export const TRANSACTIONS_PAGE_OPTIONS = [
  { value: "10", label: "10", type: "size", pageSize: 10 },
  { value: "20", label: "20", type: "size", pageSize: 20 },
  { value: "50", label: "50", type: "size", pageSize: 50 },
  { value: "100", label: "100", type: "size", pageSize: 100 },
  { value: "last_30_days", label: "30 ימים אחרונים", type: "range", range: { days: 30 } },
  { value: "last_60_days", label: "60 ימים אחרונים", type: "range", range: { days: 60 } },
  { value: "last_half_year", label: "חצי שנה אחרונה", type: "range", range: { months: 6 } },
  { value: "last_year", label: "שנה אחרונה", type: "range", range: { years: 1 } },
];

function formatIsoDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function resolveTransactionsPageOption(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value);
  return TRANSACTIONS_PAGE_OPTIONS.find((option) => option.value === normalized) || null;
}

export function getTransactionsDateRange(option, referenceDate = new Date()) {
  if (!option || option.type !== "range") {
    return null;
  }
  const range = option.range || {};
  const end = new Date(referenceDate);
  const start = new Date(referenceDate);
  if (range.days) {
    start.setDate(start.getDate() - Math.max(0, range.days - 1));
  }
  if (range.months) {
    start.setMonth(start.getMonth() - range.months);
  }
  if (range.years) {
    start.setFullYear(start.getFullYear() - range.years);
  }
  return { from: formatIsoDate(start), to: formatIsoDate(end) };
}
