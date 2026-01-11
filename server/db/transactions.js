export function reindexTransactionsChronologically(db) {
  const rows = db
    .prepare(
      `
        SELECT id
        FROM transactions
        ORDER BY txn_date ASC,
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
