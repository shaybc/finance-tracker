import express from "express";
import { z } from "zod";
import { getDb } from "../db/db.js";
import { applyRulesToTransaction } from "../ingest/categorize.js";

export const api = express.Router();

api.get("/health", (req, res) => res.json({ ok: true }));

api.get("/imports", (req, res) => {
  const db = getDb();
  const items = db.prepare("SELECT * FROM imports ORDER BY id DESC LIMIT 50").all();
  res.json({ items });
});

api.get("/categories", (req, res) => {
  const db = getDb();
  const items = db.prepare("SELECT * FROM categories ORDER BY name_he ASC").all();
  res.json({ items });
});

api.post("/categories", express.json(), (req, res) => {
  const schema = z.object({ name_he: z.string().min(1), icon: z.string().optional().nullable() });
  const body = schema.parse(req.body);

  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare("INSERT INTO categories(name_he, icon, created_at) VALUES (?, ?, ?)")
    .run(body.name_he.trim(), body.icon || null, now);

  const item = db.prepare("SELECT * FROM categories WHERE id = ?").get(row.lastInsertRowid);
  res.json({ item });
});

api.delete("/categories/:id", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();

  db.prepare("UPDATE transactions SET category_id = NULL WHERE category_id = ?").run(id);
  db.prepare("DELETE FROM rules WHERE category_id = ?").run(id);
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);

  res.json({ ok: true });
});

api.get("/rules", (req, res) => {
  const db = getDb();
  const items = db
    .prepare(`
      SELECT r.*, c.name_he AS category_name
      FROM rules r
      JOIN categories c ON c.id = r.category_id
      ORDER BY r.id DESC
    `)
    .all();
  res.json({ items });
});

api.post("/rules", express.json(), (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    match_field: z.enum(["merchant", "description", "category_raw"]),
    match_type: z.enum(["contains", "regex", "equals"]),
    pattern: z.string().min(1),
    source: z.string().optional().nullable(),
    direction: z.enum(["expense", "income"]).optional().nullable(),
    category_id: z.number().int(),
  });

  const body = schema.parse(req.body);
  const db = getDb();
  const now = new Date().toISOString();

  const row = db
    .prepare(
      `
        INSERT INTO rules(name, enabled, match_field, match_type, pattern, source, direction, category_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      body.name.trim(),
      body.enabled === false ? 0 : 1,
      body.match_field,
      body.match_type,
      body.pattern,
      body.source || null,
      body.direction || null,
      body.category_id,
      now
    );

  const item = db.prepare("SELECT * FROM rules WHERE id = ?").get(row.lastInsertRowid);
  res.json({ item });
});

api.patch("/rules/:id", express.json(), (req, res) => {
  const id = Number(req.params.id);
  const schema = z.object({ 
    enabled: z.boolean().optional(),
    name: z.string().min(1).optional(),
    match_field: z.enum(["merchant", "description", "category_raw"]).optional(),
    match_type: z.enum(["contains", "regex", "equals"]).optional(),
    pattern: z.string().min(1).optional(),
    source: z.string().optional().nullable(),
    direction: z.enum(["expense", "income"]).optional().nullable(),
    category_id: z.number().int().optional(),
  });
  const body = schema.parse(req.body);
  const db = getDb();

  // Build dynamic update query based on provided fields
  const updates = [];
  const params = [];

  if (typeof body.enabled === "boolean") {
    updates.push("enabled = ?");
    params.push(body.enabled ? 1 : 0);
  }
  if (body.name) {
    updates.push("name = ?");
    params.push(body.name.trim());
  }
  if (body.match_field) {
    updates.push("match_field = ?");
    params.push(body.match_field);
  }
  if (body.match_type) {
    updates.push("match_type = ?");
    params.push(body.match_type);
  }
  if (body.pattern) {
    updates.push("pattern = ?");
    params.push(body.pattern);
  }
  if (body.source !== undefined) {
    updates.push("source = ?");
    params.push(body.source || null);
  }
  if (body.direction !== undefined) {
    updates.push("direction = ?");
    params.push(body.direction || null);
  }
  if (body.category_id) {
    updates.push("category_id = ?");
    params.push(body.category_id);
  }

  if (updates.length > 0) {
    params.push(id);
    const sql = `UPDATE rules SET ${updates.join(", ")} WHERE id = ?`;
    db.prepare(sql).run(...params);
  }

  const item = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  res.json({ item });
});

api.delete("/rules/:id", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  db.prepare("DELETE FROM rules WHERE id = ?").run(id);
  res.json({ ok: true });
});

api.post("/rules/apply", (req, res) => {
  const db = getDb();
  const ids = db
    .prepare("SELECT id FROM transactions WHERE category_id IS NULL")
    .all()
    .map((r) => r.id);

  let updated = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      if (applyRulesToTransaction(db, id)) updated++;
    }
  });

  tx();
  res.json({ updated, scanned: ids.length });
});

function buildTxnWhere({ from, to, q, categoryId, source, direction, min, max, uncategorized }) {
  const where = [];
  const params = {};

  if (from) {
    where.push("txn_date >= @from");
    params.from = String(from);
  }
  if (to) {
    where.push("txn_date <= @to");
    params.to = String(to);
  }
  if (source) {
    where.push("source = @source");
    params.source = String(source);
  }
  if (direction) {
    where.push("direction = @direction");
    params.direction = String(direction);
  }

  if (categoryId) {
    where.push("category_id = @categoryId");
    params.categoryId = Number(categoryId);
  }
  if (uncategorized === "1") {
    where.push("category_id IS NULL");
  }

  if (q) {
    where.push("(merchant LIKE @like OR description LIKE @like OR category_raw LIKE @like)");
    params.like = `%${String(q)}%`;
  }

  if (min !== undefined && min !== null && String(min) !== "") {
    where.push("amount_signed >= @min");
    params.min = Number(min);
  }
  if (max !== undefined && max !== null && String(max) !== "") {
    where.push("amount_signed <= @max");
    params.max = Number(max);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, params };
}

api.get("/transactions", (req, res) => {
  const db = getDb();

  const {
    from,
    to,
    q,
    categoryId,
    source,
    direction,
    min,
    max,
    uncategorized,
    sort = "txn_date_desc",
    page = "1",
    pageSize = "50",
  } = req.query;

  const { whereSql, params: baseParams } = buildTxnWhere({
    from,
    to,
    q,
    categoryId,
    source,
    direction,
    min,
    max,
    uncategorized,
  });

  const pageNum = Math.max(1, Number(page) || 1);
  const pageSizeNum = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const offset = (pageNum - 1) * pageSizeNum;

  const orderBy = (() => {
    switch (sort) {
      case "txn_date_asc":
        return "t.txn_date ASC, t.id ASC";
      case "amount_desc":
        return "t.amount_signed DESC, t.id DESC";
      case "amount_asc":
        return "t.amount_signed ASC, t.id ASC";
      case "abs_amount_desc":
        return "ABS(t.amount_signed) DESC, t.id DESC";
      default:
        return "t.txn_date DESC, t.id DESC";
    }
  })();

  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM transactions t ${whereSql}`).get(baseParams);
  const total = Number(totalRow?.c || 0);

  const params = { ...baseParams, limit: pageSizeNum, offset };

  const rows = db
    .prepare(
      `
        SELECT t.*, c.name_he AS category_name, c.icon AS category_icon
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        ${whereSql}
        ORDER BY ${orderBy}
        LIMIT @limit OFFSET @offset
      `
    )
    .all(params);

  res.json({ rows, total, page: pageNum, pageSize: pageSizeNum });
});

api.patch("/transactions/:id", express.json(), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);

  const schema = z.object({
    category_id: z.number().int().nullable(),
  });
  const body = schema.parse(req.body);

  if (body.category_id === null) {
    db.prepare("UPDATE transactions SET category_id = NULL WHERE id = ?").run(id);
  } else {
    const exists = db.prepare("SELECT id FROM categories WHERE id = ?").get(body.category_id);
    if (!exists) {
      res.status(400).json({ error: "category_id not found" });
      return;
    }
    db.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").run(body.category_id, id);
  }

  const row = db
    .prepare(
      `
        SELECT t.*, c.name_he AS category_name, c.icon AS category_icon
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.id = ?
      `
    )
    .get(id);

  res.json({ row });
});

api.get("/stats/summary", (req, res) => {
  const db = getDb();
  const { from, to, source } = req.query;

  const { whereSql, params } = buildTxnWhere({ from, to, source });

  const row = db
    .prepare(
      `
        SELECT
          COUNT(*) AS count,
          SUM(CASE WHEN direction = 'expense' THEN amount_signed ELSE 0 END) AS expense_sum,
          SUM(CASE WHEN direction = 'income' THEN amount_signed ELSE 0 END) AS income_sum
        FROM transactions
        ${whereSql}
      `
    )
    .get(params);

  const expenseSum = Number(row?.expense_sum || 0);
  const incomeSum = Number(row?.income_sum || 0);

  res.json({
    count: Number(row?.count || 0),
    expenses: Math.abs(expenseSum),
    income: incomeSum,
    net: incomeSum + expenseSum,
  });
});

// Convenience endpoint for setting sensible default date filters in the UI
api.get("/stats/date-range", (req, res) => {
  const db = getDb();
  const row = db
    .prepare("SELECT MIN(txn_date) AS minDate, MAX(txn_date) AS maxDate FROM transactions")
    .get();

  res.json({
    minDate: row?.minDate || null,
    maxDate: row?.maxDate || null,
  });
});

api.get("/stats/by-category", (req, res) => {
  const db = getDb();
  const { from, to, source, direction = "expense" } = req.query;

  const { whereSql, params } = buildTxnWhere({ from, to, source, direction });

  const rows = db
    .prepare(
      `
        SELECT
          COALESCE(c.name_he, 'לא מסווג') AS category,
          COALESCE(c.icon, '') AS icon,
          SUM(t.amount_signed) AS total
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        ${whereSql}
        GROUP BY category, icon
        ORDER BY ABS(total) DESC
        LIMIT 200
      `
    )
    .all(params);

  res.json({ rows });
});

api.get("/stats/timeseries", (req, res) => {
  const db = getDb();
  const { from, to, group = "month", direction } = req.query;

  const where = [];
  const params = {};
  if (from) {
    where.push("txn_date >= @from");
    params.from = String(from);
  }
  if (to) {
    where.push("txn_date <= @to");
    params.to = String(to);
  }
  if (direction) {
    where.push("direction = @direction");
    params.direction = String(direction);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const keyExpr = (() => {
    switch (group) {
      case "day":
        return "txn_date";
      case "week":
        return "strftime('%Y-W%W', txn_date)";
      case "year":
        return "strftime('%Y', txn_date)";
      case "quarter":
        return "strftime('%Y', txn_date) || '-Q' || (((CAST(strftime('%m', txn_date) AS integer)-1)/3)+1)";
      default:
        return "strftime('%Y-%m', txn_date)";
    }
  })();

  const rows = db
    .prepare(
      `
        SELECT ${keyExpr} AS k, SUM(amount_signed) AS total
        FROM transactions
        ${whereSql}
        GROUP BY k
        ORDER BY k ASC
      `
    )
    .all(params);

  res.json({ rows });
});

api.get("/stats/anomalies", (req, res) => {
  const db = getDb();
  const { from, to, minAbs = "500" } = req.query;

  const where = ["ABS(amount_signed) >= @minAbs"];
  const params = { minAbs: Number(minAbs) };
  if (from) {
    where.push("txn_date >= @from");
    params.from = String(from);
  }
  if (to) {
    where.push("txn_date <= @to");
    params.to = String(to);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const rows = db
    .prepare(
      `
        SELECT t.*, c.name_he AS category_name, c.icon AS category_icon
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        ${whereSql}
        ORDER BY ABS(amount_signed) DESC
        LIMIT 100
      `
    )
    .all(params);

  res.json({ rows });
});
