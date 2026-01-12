export const DASHBOARD_RANGE_OPTIONS = [
  { value: "custom", label: "בחירת טווח" },
  { value: "30", label: "30 ימים אחרונים" },
  { value: "60", label: "60 ימים אחרונים" },
  { value: "half-year", label: "חצי שנה אחרונה" },
  { value: "year", label: "שנה אחרונה" },
];

const DASHBOARD_RANGE_VALUES = new Set(DASHBOARD_RANGE_OPTIONS.map((option) => option.value));

export function resolveDashboardRange(value) {
  if (!value) return null;
  const normalized = String(value);
  return DASHBOARD_RANGE_VALUES.has(normalized) ? normalized : null;
}
