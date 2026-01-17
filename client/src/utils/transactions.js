export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200];
export const PAGE_SIZE_PREFERENCE_STORAGE_KEY = "transactions.pageSize.preference";
export const TRANSACTIONS_RANGE_PREFERENCE_STORAGE_KEY =
  "transactions.range.preference";
export const DEFAULT_TRANSACTION_COLORING = {
  enabled: true,
  incomeColor: "#16a34a",
  expenseColor: "#000000",
};

export const TRANSACTIONS_PAGE_SIZE_OPTIONS = PAGE_SIZE_OPTIONS.map((size) => ({
  value: String(size),
  label: String(size),
  pageSize: size,
}));

export const TRANSACTIONS_RANGE_OPTIONS = [
  {
    value: "all",
    label: "כל התנועות הקיימות",
    range: null,
  },
  {
    value: "current_month",
    label: "חודש נוכחי",
    range: { currentMonth: true },
  },
  {
    value: "current_and_last_month",
    label: "מהחודש שעבר",
    range: { currentAndLastMonth: true },
  },
  { value: "last_30_days", label: "30 ימים אחרונים", range: { days: 30 } },
  { value: "last_60_days", label: "60 ימים אחרונים", range: { days: 60 } },
  { value: "last_half_year", label: "חצי שנה אחרונה", range: { months: 6 } },
  { value: "last_year", label: "שנה אחרונה", range: { years: 1 } },
];

function formatIsoDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function resolveTransactionsPageSizeOption(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value);
  return TRANSACTIONS_PAGE_SIZE_OPTIONS.find((option) => option.value === normalized) || null;
}

export function resolveTransactionsRangeOption(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value);
  return TRANSACTIONS_RANGE_OPTIONS.find((option) => option.value === normalized) || null;
}

export function getTransactionsDateRange(option, referenceDate = new Date()) {
  if (!option) {
    return null;
  }
  const range = option.range || {};
  const end = new Date(referenceDate);
  const start = new Date(referenceDate);
  if (range.currentMonth) {
    start.setDate(1);
  }
  if (range.currentAndLastMonth) {
    start.setMonth(start.getMonth() - 1);
    start.setDate(1);
  }
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
