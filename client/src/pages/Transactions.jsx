import React, { useEffect, useState } from "react";
import { apiGet, apiPatch } from "../api.js";
import FiltersBar from "../components/FiltersBar.jsx";
import TransactionsTable from "../components/TransactionsTable.jsx";
import { isoMonthStart, isoToday, formatILS } from "../utils/format.js";

export default function Transactions() {
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({
    from: isoMonthStart(),
    to: isoToday(),
    q: "",
    source: "",
    categoryId: "",
    direction: "",
    uncategorized: "0",
  });
  const [data, setData] = useState({ rows: [], total: 0, totalAmount: 0, page: 1, pageSize: 50 });
  const [loading, setLoading] = useState(false);

  // If DB has data outside the current month, default UI range to DB min/max
  useEffect(() => {
    apiGet("/api/stats/date-range")
      .then((r) => {
        if (r?.minDate && r?.maxDate) {
          setFilters((f) => ({ ...f, from: r.minDate, to: r.maxDate }));
        }
      })
      .catch(console.error);
  }, []);

  const sources = [
    { value: "bank", label: "בנק" },
    { value: "visa_portal", label: "ויזה (פורטל)" },
    { value: "max", label: "מקס" },
  ];

  async function load(page = 1) {
    setLoading(true);
    try {
      const cat = await apiGet("/api/categories");
      setCategories(cat.items || []);

      const qs = new URLSearchParams({
        from: filters.from || "",
        to: filters.to || "",
        q: filters.q || "",
        source: filters.source || "",
        categoryId: filters.categoryId || "",
        direction: filters.direction || "",
        uncategorized: filters.uncategorized || "0",
        page: String(page),
        pageSize: "50",
        sort: "txn_date_desc",
      }).toString();

      const res = await apiGet(`/api/transactions?${qs}`);
      setData(res);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(1).catch(console.error);
  }, [JSON.stringify(filters)]);

  async function onUpdateCategory(id, categoryId) {
    await apiPatch(`/api/transactions/${id}`, { category_id: categoryId });
    await load(data.page);
  }

  function onFilterByDescription(description, categoryId) {
    if (description !== undefined && description !== null) {
      setFilters(prev => ({ ...prev, q: description }));
    }
    if (categoryId !== undefined && categoryId !== null) {
      setFilters(prev => ({ ...prev, categoryId: String(categoryId) }));
    }
  }

  function onFilterByDirection(direction) {
    setFilters(prev => ({ ...prev, direction }));
  }

  function onFilterByMonth(fromDate, toDate) {
    setFilters(prev => ({ ...prev, from: fromDate, to: toDate }));
  }

  const totalAmount = Number(data.totalAmount || 0);

  return (
    <div>
      <FiltersBar filters={filters} setFilters={setFilters} categories={categories} sources={sources} />

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-4">
          <div className="text-sm text-slate-600">
            {loading ? "טוען..." : `סה״כ: ${data.total.toLocaleString("he-IL")} תנועות`}
          </div>
          <div className="text-sm font-semibold text-slate-900">
            סכום כולל: {formatILS(totalAmount)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn" disabled={data.page <= 1} onClick={() => load(data.page - 1)}>
            הקודם
          </button>
          <div className="text-sm">עמוד {data.page}</div>
          <button
            className="btn"
            disabled={data.page * data.pageSize >= data.total}
            onClick={() => load(data.page + 1)}
          >
            הבא
          </button>
        </div>
      </div>

      <TransactionsTable 
        rows={data.rows} 
        categories={categories} 
        onUpdateCategory={onUpdateCategory}
        onFilterByDescription={onFilterByDescription}
        onFilterByDirection={onFilterByDirection}
        onFilterByMonth={onFilterByMonth}
      />
    </div>
  );
}
