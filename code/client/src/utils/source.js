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

export function formatSourceLabel(source, { cardLast4 } = {}) {
  if (!source) return "—";
  if (source === "bank") return "בנק";
  if (source === "visa_portal" || source === "max") {
    return formatCardSource(cardLast4);
  }
  if (source.startsWith("כ.אשראי")) {
    return source;
  }
  return source;
}
