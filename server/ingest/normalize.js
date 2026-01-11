import { sha256Hex } from "../utils/hash.js";

function normalizeText(s) {
  if (!s) return null;
  return String(s).replace(/\s+/g, " ").trim() || null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function normalizeRecord(rec, { sourceFile, sourceRow }) {
  const source = rec.source;

  if (source === "bank") {
    const amountSigned = Number(rec.amountSigned ?? 0);
    const direction = amountSigned < 0 ? "expense" : "income";
    const merchant = normalizeText(rec.merchant);
    const description = normalizeText(rec.description) || merchant;

    const base = {
      source,
      sourceFile,
      sourceRow,
      accountRef: rec.accountRef || null,
      txnDate: rec.txnDate,
      postingDate: rec.postingDate || null,
      merchant: merchant,
      description,
      categoryRaw: rec.categoryRaw || null,
      originalTxnDate: rec.originalTxnDate || null,
      originalAmountSigned:
        rec.originalAmount != null
          ? round2(amountSigned < 0 ? -Math.abs(rec.originalAmount) : Math.abs(rec.originalAmount))
          : null,
      amountSigned: round2(amountSigned),
      balanceAmount: rec.balance != null ? round2(rec.balance) : null,
      currency: rec.currency === "₪" ? "ILS" : (rec.currency || "ILS"),
      direction,
      tags: null,
      raw: rec.raw,
    };

    base.dedupeKey = buildDedupeKey(base);
    return base;
  }

  // credit cards
  const merchant = normalizeText(rec.merchant);
  const description = merchant;
  const amount = Number(rec.amountCharge ?? 0);

  let amountSigned = -Math.abs(amount);
  let direction = "expense";

  const typeRaw = normalizeText(rec.typeRaw) || "";
  if (amount < 0 || typeRaw.includes("זיכוי") || typeRaw.includes("החזר")) {
    amountSigned = Math.abs(amount);
    direction = "income";
  }

  const base = {
    source,
    sourceFile,
    sourceRow,
    accountRef: rec.cardLast4 || rec.accountRef || null,
    txnDate: rec.txnDate,
    postingDate: rec.postingDate || null,
    merchant,
    description,
    categoryRaw: rec.categoryRaw || null,
    originalTxnDate: rec.originalTxnDate || null,
    originalAmountSigned:
      rec.originalAmount != null
        ? round2(amountSigned < 0 ? -Math.abs(rec.originalAmount) : Math.abs(rec.originalAmount))
        : null,
    amountSigned: round2(amountSigned),
    currency: rec.currency === "₪" ? "ILS" : (rec.currency || "ILS"),
    direction,
    tags: null,
    raw: rec.raw,
  };

  base.dedupeKey = buildDedupeKey(base);
  return base;
}

function buildDedupeKey(n) {
  // Stable identity across re-imports
  const txnDate = n.txnDate || n.postingDate || "";
  const postingDate = n.postingDate || "";
  const payload = {
    source: n.source,
    accountRef: n.accountRef || "",
    txnDate,
    postingDate,
    merchant: n.merchant || "",
    description: n.description || "",
    amountSigned: n.amountSigned,
    currency: n.currency,
  };
  return sha256Hex(JSON.stringify(payload));
}
