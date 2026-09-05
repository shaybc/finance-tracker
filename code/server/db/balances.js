// Canonical transaction balance recalculation for real and affected balances.

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function parseTagIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => Number(item)).filter((item) => Number.isFinite(item));
    }
  } catch {
    // Keep supporting comma-separated legacy values.
  }
  return String(value)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function getExcludedTagIds(db) {
  return new Set(
    db.prepare("SELECT id FROM tags WHERE exclude_from_calculations = 1")
      .all()
      .map((row) => Number(row.id))
  );
}

function hasExcludedTags(tagValue, excludedTagIds) {
  if (!excludedTagIds.size) return false;
  return parseTagIds(tagValue).some((tagId) => excludedTagIds.has(tagId));
}

function isRealBankBalance(row) {
  return row.source === "bank" && row.real_balance_after != null;
}

function getBalanceOrderSql() {
  return `chronological_index IS NULL,
    chronological_index,
    txn_date,
    CASE WHEN source LIKE 'כ.אשראי%' THEN 1 ELSE 0 END,
    COALESCE(intra_day_index, source_row, id),
    id`;
}

/**
 * Recalculate persisted balances for the full transaction timeline.
 * @param {import("better-sqlite3").Database} db - Open SQLite database connection.
 * @returns {{updated: number, anchorTransactionId: number|null}} Number of updated rows and the real-bank anchor used.
 */
export function recalculateTransactionBalances(db) {
  const excludedTagIds = getExcludedTagIds(db);
  const rows = db
    .prepare(
      `
        SELECT id, source, txn_date, source_row, intra_day_index, chronological_index,
          amount_signed, tags, real_balance_after
        FROM transactions
        ORDER BY ${getBalanceOrderSql()}
      `
    )
    .all();

  const updates = [];
  const anchorIndex = rows.findIndex(isRealBankBalance);
  let runningBalance = null;
  let anchorTransactionId = null;

  rows.forEach((row, index) => {
    if (index < anchorIndex || anchorIndex < 0) {
      updates.push({
        id: row.id,
        affectedBalanceAfter: null,
        balanceAmount: null,
        balanceIsCalculated: 0,
      });
      return;
    }

    if (index === anchorIndex) {
      runningBalance = round2(Number(row.real_balance_after) - Number(row.amount_signed || 0));
      anchorTransactionId = row.id;
    }

    if (!hasExcludedTags(row.tags, excludedTagIds)) {
      runningBalance = round2(runningBalance + Number(row.amount_signed || 0));
    }

    const realBalance = row.real_balance_after == null ? null : round2(row.real_balance_after);
    const affectedBalance = runningBalance == null ? null : round2(runningBalance);
    updates.push({
      id: row.id,
      affectedBalanceAfter: affectedBalance,
      balanceAmount: affectedBalance,
      balanceIsCalculated: realBalance != null && affectedBalance === realBalance ? 0 : 1,
    });
  });

  const updateStmt = db.prepare(
    `UPDATE transactions
     SET affected_balance_after = ?, balance_amount = ?, balance_is_calculated = ?
     WHERE id = ?`
  );
  const tx = db.transaction(() => {
    updates.forEach((update) => {
      updateStmt.run(
        update.affectedBalanceAfter,
        update.balanceAmount,
        update.balanceIsCalculated,
        update.id
      );
    });
  });
  tx();

  return { updated: updates.length, anchorTransactionId };
}