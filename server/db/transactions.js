export function reindexTransactionsChronologically(db) {
  const effectiveTxnDate =
    "CASE WHEN original_txn_date IS NOT NULL THEN COALESCE(posting_date, txn_date) ELSE txn_date END";
  const rows = db
    .prepare(
      `
        SELECT id
        FROM transactions
        ORDER BY ${effectiveTxnDate} ASC,
          CASE WHEN source LIKE 'כ.אשראי%' THEN 1 ELSE 0 END ASC,
          source ASC,
          COALESCE(intra_day_index, source_row, id) DESC,
          id ASC
      `
    )
    .all();

  if (rows.length === 0) {
    return 0;
  }

  const update = db.prepare("UPDATE transactions SET chronological_index = ? WHERE id = ?");
  const tx = db.transaction(() => {
    rows.forEach((row, index) => {
      update.run(index + 1, row.id);
    });
  });
  tx();
  return rows.length;
}
