import React, { useEffect, useRef, useState } from "react";
import { apiGet, apiPatch } from "../api.js";
import FiltersBar from "../components/FiltersBar.jsx";
import TransactionsTable from "../components/TransactionsTable.jsx";
import { isoMonthStart, isoToday, formatILS } from "../utils/format.js";
import { formatSourceLabel } from "../utils/source.js";

export default function Transactions() {
  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [sources, setSources] = useState([]);
  const [filters, setFilters] = useState({
    from: isoMonthStart(),
    to: isoToday(),
    q: "",
    source: "",
    categoryId: "",
    tagIds: [],
    direction: "",
    uncategorized: "0",
  });
  const [data, setData] = useState({ rows: [], total: 0, totalAmount: 0, page: 1, pageSize: 50 });
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [isEditingPage, setIsEditingPage] = useState(false);
  const [pageValue, setPageValue] = useState("1");
  const activeLoadId = useRef(0);

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

  const sourceOptions = [
    { value: "bank", label: formatSourceLabel("bank") },
    ...Array.from(new Set(sources.filter(Boolean)))
      .filter((value) => value !== "bank")
      .map((value) => ({ value, label: formatSourceLabel(value) })),
  ];

  async function load(page = 1) {
    const loadId = ++activeLoadId.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        from: filters.from || "",
        to: filters.to || "",
        q: filters.q || "",
        source: filters.source || "",
        categoryId: filters.categoryId || "",
        tagIds: (filters.tagIds || []).join(","),
        direction: filters.direction || "",
        uncategorized: filters.uncategorized || "0",
        page: String(page),
        pageSize: String(pageSize),
        sort: "txn_date_desc",
      }).toString();
      const [cat, tagRes, src, res] = await Promise.all([
        apiGet("/api/categories"),
        apiGet("/api/tags"),
        apiGet("/api/sources"),
        apiGet(`/api/transactions?${qs}`),
      ]);
      if (loadId !== activeLoadId.current) {
        return;
      }
      setCategories(cat.items || []);
      setTags(tagRes.items || []);
      setSources(src.items || []);
      setData(res);
    } finally {
      if (loadId === activeLoadId.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    load(1).catch(console.error);
  }, [JSON.stringify(filters), pageSize]);

  useEffect(() => {
    if (!isEditingPage) {
      setPageValue(String(data.page || 1));
    }
  }, [data.page, isEditingPage]);

  async function onUpdateCategory(id, categoryId) {
    await apiPatch(`/api/transactions/${id}`, { category_id: categoryId });
    await load(data.page);
  }

  async function onUpdateTags(id, tagIds) {
    await apiPatch(`/api/transactions/${id}`, { tags: tagIds });
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
  const totalPages = Math.max(1, Math.ceil((data.total || 0) / pageSize));

  function commitPageChange() {
    const parsedPage = Number.parseInt(pageValue, 10);
    const targetPage = Number.isNaN(parsedPage) || parsedPage < 1 || parsedPage > totalPages
      ? totalPages
      : parsedPage;
    setIsEditingPage(false);
    if (targetPage !== data.page) {
      load(targetPage);
    }
  }

  return (
    <div>
      <FiltersBar
        filters={filters}
        setFilters={setFilters}
        categories={categories}
        sources={sourceOptions}
        tags={tags}
      />

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-4">
          <div className="text-sm text-slate-600">
            {loading ? "טוען..." : `סה״כ: ${data.total.toLocaleString("he-IL")} תנועות`}
          </div>
          <div className="text-sm font-semibold text-slate-900">
            סכום כולל:{" "}
            <span className="inline-block tabular-nums text-right" dir="ltr">
              {formatILS(totalAmount)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            שורות להציג
            <select
              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
              value={pageSize}
              onChange={(event) => {
                const nextSize = Number(event.target.value);
                setIsEditingPage(false);
                setPageValue("1");
                setPageSize(nextSize);
              }}
            >
              {[10, 20, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" disabled={data.page <= 1} onClick={() => load(data.page - 1)}>
            הקודם
          </button>
          {isEditingPage ? (
            <input
              className="h-9 w-20 rounded-lg border border-slate-200 bg-white px-2 text-center text-sm shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
              value={pageValue}
              onChange={(event) => setPageValue(event.target.value.replace(/\D/g, ""))}
              onBlur={commitPageChange}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitPageChange();
                }
              }}
              inputMode="numeric"
              pattern="[0-9]*"
              aria-label="הזן מספר עמוד"
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="text-sm text-slate-700 underline decoration-dotted underline-offset-4"
              onClick={() => {
                setPageValue(String(data.page || 1));
                setIsEditingPage(true);
              }}
            >
              עמוד {data.page} מתוך {totalPages}
            </button>
          )}
          <button
            className="btn"
            disabled={data.page * pageSize >= data.total}
            onClick={() => load(data.page + 1)}
          >
            הבא
          </button>
        </div>
      </div>

      <TransactionsTable 
        rows={data.rows} 
        categories={categories} 
        tags={tags}
        onUpdateCategory={onUpdateCategory}
        onUpdateTags={onUpdateTags}
        onFilterByDescription={onFilterByDescription}
        onFilterByDirection={onFilterByDirection}
        onFilterByMonth={onFilterByMonth}
      />
    </div>
  );
}
