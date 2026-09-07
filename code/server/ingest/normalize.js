import { sha256Hex } from "../utils/hash.js";

function normalizeText(s) {
  if (!s) return null;
  return String(s).replace(/\s+/g, " ").trim() || null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function resolveTxnDates(txnDate, postingDate, originalTxnDate = null) {
  if (!txnDate || !postingDate) {
    return { txnDate, originalTxnDate };
  }
  const txnParsed = new Date(txnDate);
  const postingParsed = new Date(postingDate);
  if (Number.isNaN(txnParsed.getTime()) || Number.isNaN(postingParsed.getTime())) {
    return { txnDate, originalTxnDate };
  }
  const daysDiff = (postingParsed.getTime() - txnParsed.getTime()) / (1000 * 60 * 60 * 24);
  if (daysDiff > 31) {
    return {
      txnDate: postingDate,
      originalTxnDate: originalTxnDate || txnDate,
    };
  }
  return { txnDate, originalTxnDate };
}

export function normalizeRecord(rec, { sourceFile, sourceRow }) {
  const source = rec.source;

  if (source === "bank") {
    const amountSigned = Number(rec.amountSigned ?? 0);
    const direction = amountSigned < 0 ? "expense" : "income";
    const merchant = normalizeText(rec.merchant);
    const description = normalizeText(rec.description) || merchant;

    const resolved = resolveTxnDates(rec.txnDate, rec.postingDate, rec.originalTxnDate || null);
    const base = {
      source,
      sourceFile,
      sourceRow,
      accountRef: rec.accountRef || null,
      txnDate: resolved.txnDate,
      postingDate: rec.postingDate || null,
      merchant: merchant,
      description,
      categoryRaw: rec.categoryRaw || null,
      originalTxnDate: resolved.originalTxnDate,
      originalAmountSigned:
        rec.originalAmount != null
          ? round2(amountSigned < 0 ? -Math.abs(rec.originalAmount) : Math.abs(rec.originalAmount))
          : null,
      amountSigned: round2(amountSigned),
      realBalanceAfter: rec.balance != null ? round2(rec.balance) : null,
      affectedBalanceAfter: null,
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

  const resolved = rec.raw?._visa?.version === 2
    ? { txnDate: rec.txnDate, originalTxnDate: rec.originalTxnDate || null }
    : resolveTxnDates(rec.txnDate, rec.postingDate, rec.originalTxnDate || null);
  const base = {
    source,
    sourceFile,
    sourceRow,
    accountRef: rec.cardLast4 || rec.accountRef || null,
    txnDate: resolved.txnDate,
    postingDate: rec.postingDate || null,
    merchant,
    description,
    categoryRaw: rec.categoryRaw || null,
    originalTxnDate: resolved.originalTxnDate,
    originalAmountSigned:
      rec.originalAmount != null
        ? round2(amountSigned < 0 ? -Math.abs(rec.originalAmount) : Math.abs(rec.originalAmount))
        : null,
    amountSigned: round2(amountSigned),
    realBalanceAfter: null,
    affectedBalanceAfter: null,
    balanceAmount: null,
    currency: rec.currency === "₪" ? "ILS" : (rec.currency || "ILS"),
    direction,
    tags: null,
    raw: rec.raw,
  };

  base.dedupeKey = buildDedupeKey(base);
  if (base.raw?._visa?.version === 2) {
    base.raw = { ...base.raw, _visa: { ...base.raw._visa, originalAmountSigned: base.originalAmountSigned } };
  }
  return base;
}

export function buildDedupeKey(n) {
  const visa = n.raw?._visa;
  if (visa?.version === 2 && visa.isInstallment) {
    return sha256Hex(JSON.stringify({
      identity: "visa-installment-v2", accountRef: n.accountRef || "",
      originalTxnDate: visa.originalTxnDate, statementMonth: visa.statementMonth,
      installmentCurrent: visa.installmentCurrent, installmentTotal: visa.installmentTotal,
      merchant: n.merchant || "", amountSigned: n.amountSigned, currency: n.currency,
    }));
  }
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

/** Keep resolved Visa dates consistent between API sorting and persisted chronology. */
export function effectiveTransactionDateSql(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `CASE WHEN (CASE WHEN json_valid(${p}raw_json) THEN json_extract(${p}raw_json, '$._visa.version') END) = 2 THEN COALESCE(${p}txn_date, ${p}posting_date)
    WHEN ${p}posting_date IS NOT NULL AND ${p}txn_date IS NOT NULL AND (julianday(${p}posting_date) - julianday(${p}txn_date)) > 31 THEN ${p}posting_date ELSE COALESCE(${p}txn_date, ${p}posting_date) END`;
}
