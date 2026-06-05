export function normalizeCardLast4(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return null;
  return digits.slice(-4).padStart(4, "0");
}

export function formatCardSource(last4) {
  const normalized = normalizeCardLast4(last4);
  return normalized ? `כ.אשראי (${normalized})` : "כ.אשראי";
}

export function extractCardLast4FromFileName(fileName) {
  if (!fileName) return null;
  const match = String(fileName).match(/(\d{4})(?!.*\d{4})/);
  return match ? normalizeCardLast4(match[1]) : null;
}
