import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { apiGet, apiPatch, apiPost } from "../api.js";
import FiltersBar from "../components/FiltersBar.jsx";
import TransactionsTable from "../components/TransactionsTable.jsx";
import { isoMonthStart, isoToday, formatILS } from "../utils/format.js";
import { formatSourceLabel } from "../utils/source.js";
import {
  PAGE_SIZE_OPTIONS as TRANSACTIONS_PAGE_SIZE_OPTIONS,
  PAGE_SIZE_PREFERENCE_STORAGE_KEY as TRANSACTIONS_PAGE_SIZE_PREFERENCE_STORAGE_KEY,
} from "../utils/transactions.js";

export default function Transactions() {
  const location = useLocation();
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
    untagged: "0",
    uncategorized: "0",
  });
  const [data, setData] = useState({
    rows: [],
    total: 0,
    totalAmount: 0,
    openingBalance: 0,
    incomeTotal: 0,
    expenseTotal: 0,
    dateRange: { minDate: null, maxDate: null },
    page: 1,
    pageSize: 50,
  });
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [showTotalsBreakdown, setShowTotalsBreakdown] = useState(false);
  const [showTransactionsRange, setShowTransactionsRange] = useState(false);
  const [isEditingPage, setIsEditingPage] = useState(false);
  const [isRefreshingTransactions, setIsRefreshingTransactions] = useState(false);
  const [pageValue, setPageValue] = useState("1");
  const [sortConfig, setSortConfig] = useState({ key: "txn_date", direction: "desc" });
  const activeLoadId = useRef(0);
  const hasQueryFilters = useRef(false);

  // If DB has data outside the current month, default UI range to DB min/max
  useEffect(() => {
    let isMounted = true;
    const preferredSize = Number(
      localStorage.getItem(TRANSACTIONS_PAGE_SIZE_PREFERENCE_STORAGE_KEY)
    );

    apiGet("/api/settings/transactions-page-size")
      .then((data) => {
        if (!isMounted) return;
        const defaultSize = Number(data?.pageSizeDefault);
        if (TRANSACTIONS_PAGE_SIZE_OPTIONS.includes(defaultSize)) {
          setPageSize(defaultSize);
        }
        if (TRANSACTIONS_PAGE_SIZE_OPTIONS.includes(preferredSize)) {
          setPageSize(preferredSize);
        }
      })
      .catch((error) => {
        console.error(error);
        if (!isMounted) return;
        if (TRANSACTIONS_PAGE_SIZE_OPTIONS.includes(preferredSize)) {
          setPageSize(preferredSize);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const hasParams = Boolean(params.toString());
    hasQueryFilters.current = hasParams;
    if (!hasParams) {
      return;
    }

    setFilters((prev) => ({
      ...prev,
      from: params.get("from") || prev.from,
      to: params.get("to") || prev.to,
      categoryId: params.get("categoryId") || "",
      untagged: params.get("untagged") === "1" ? "1" : "0",
      uncategorized: params.get("uncategorized") === "1" ? "1" : "0",
      tagIds: [],
      q: "",
      source: "",
      direction: params.get("direction") || "",
    }));
  }, [location.search]);

  useEffect(() => {
    if (hasQueryFilters.current) {
      return;
    }
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

  function getSortParam({ key, direction }) {
    switch (key) {
      case "amount":
        return `amount_${direction}`;
      case "description":
        return `description_${direction}`;
      case "tags":
        return `tags_${direction}`;
      case "category":
        return `category_${direction}`;
      case "source":
        return `source_${direction}`;
      case "balance":
        return `balance_${direction}`;
      case "chronological_index":
        return `chronological_index_${direction}`;
      case "txn_date":
      default:
        return `txn_date_${direction}`;
    }
  }

  async function load(page = 1) {
    const loadId = ++activeLoadId.current;
    setLoading(true);
    try {
      const sortParam = getSortParam(sortConfig);
      const qs = new URLSearchParams({
        from: filters.from || "",
        to: filters.to || "",
        q: filters.q || "",
        source: filters.source || "",
        categoryId: filters.categoryId || "",
        tagIds: (filters.tagIds || []).join(","),
        direction: filters.direction || "",
        untagged: filters.untagged || "0",
        uncategorized: filters.uncategorized || "0",
        page: String(page),
        pageSize: String(pageSize),
        sort: sortParam,
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
  }, [JSON.stringify(filters), pageSize, JSON.stringify(sortConfig)]);

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

  async function onBulkUpdateCategory(rowIds, categoryId) {
    if (!rowIds.length) return;
    await Promise.all(
      rowIds.map((id) => apiPatch(`/api/transactions/${id}`, { category_id: categoryId }))
    );
    await load(data.page);
  }

  async function onBulkUpdateTags(updates) {
    if (!updates.length) return;
    await Promise.all(
      updates.map(({ id, tags: tagIds }) => apiPatch(`/api/transactions/${id}`, { tags: tagIds }))
    );
    await load(data.page);
  }

  async function handleRefreshTransactions() {
    if (isRefreshingTransactions) {
      return;
    }
    setIsRefreshingTransactions(true);
    try {
      await apiPost("/api/transactions/reindex");
      await load(data.page);
    } finally {
      setIsRefreshingTransactions(false);
    }
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

  function parseTagIds(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((item) => Number(item)).filter((item) => !Number.isNaN(item));
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => Number(item)).filter((item) => !Number.isNaN(item));
        }
      } catch {
        // ignore parse errors
      }
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => Number(item))
        .filter((item) => !Number.isNaN(item));
    }
    return [];
  }

  const hiddenTagIds = new Set(
    tags.filter((tag) => tag.hide_from_transactions).map((tag) => tag.id)
  );
  const activeTagFilterIds = new Set(
    (filters.tagIds || [])
      .map((value) => Number(value))
      .filter((value) => !Number.isNaN(value))
  );
  const visibleRows = hiddenTagIds.size
    ? data.rows.filter((row) => {
        const rowTagIds = parseTagIds(row.tags);
        return !rowTagIds.some(
          (tagId) => hiddenTagIds.has(tagId) && !activeTagFilterIds.has(tagId)
        );
      })
    : data.rows;

  const totalAmount = Number(data.totalAmount || 0);
  const openingBalance = Number(data.openingBalance || 0);
  const incomeTotal = Number(data.incomeTotal || 0);
  const expenseTotal = Number(data.expenseTotal || 0);
  const totalPages = Math.max(1, Math.ceil((data.total || 0) / pageSize));
  const shouldShowOpeningBalanceRow = openingBalance !== 0 && data.page === totalPages;
  const rowsWithOpeningBalance = shouldShowOpeningBalanceRow
    ? [
        ...visibleRows,
        {
          id: `opening-balance-${filters.from || "start"}`,
          txn_date: filters.from || null,
          amount_signed: openingBalance,
          balance_amount: openingBalance,
          description: "יתרת פתיחה",
          isOpeningBalance: true,
        },
      ]
    : visibleRows;

  function formatTransactionRange(range) {
    if (!range?.minDate || !range?.maxDate) {
      return "אין טווח תאריכים";
    }
    const start = new Date(`${range.minDate}T00:00:00Z`);
    const end = new Date(`${range.maxDate}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return "אין טווח תאריכים";
    }
    if (end <= start) {
      return "0 ימים";
    }
    const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
    const startDate = new Date(startUtc);
    const endDate = new Date(endUtc);
    let totalMonths =
      (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
      (endDate.getUTCMonth() - startDate.getUTCMonth());
    if (endDate.getUTCDate() < startDate.getUTCDate()) {
      totalMonths -= 1;
    }
    if (totalMonths < 0) {
      totalMonths = 0;
    }
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;
    const normalizedStart = new Date(
      Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth() + totalMonths,
        startDate.getUTCDate()
      )
    );
    const msPerDay = 24 * 60 * 60 * 1000;
    const days = Math.floor((endUtc - normalizedStart.getTime()) / msPerDay);
    const parts = [];
    if (years > 0) {
      parts.push(`${years} ${years === 1 ? "שנה" : "שנים"}`);
    }
    if (months > 0) {
      parts.push(`${months} ${months === 1 ? "חודש" : "חודשים"}`);
    }
    parts.push(`${days} ${days === 1 ? "יום" : "ימים"}`);
    return parts.join(" ו-");
  }

  const transactionRangeLabel = formatTransactionRange(data.dateRange);

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

  function handleSortChange(key) {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: "asc" };
    });
    setIsEditingPage(false);
    setPageValue("1");
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
          <div
            className="relative text-sm text-slate-600"
            onMouseEnter={() => setShowTransactionsRange(true)}
            onMouseLeave={() => setShowTransactionsRange(false)}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onFocus={() => setShowTransactionsRange(true)}
              onBlur={() => setShowTransactionsRange(false)}
            >
              {loading ? "טוען..." : `סה״כ: ${data.total.toLocaleString("he-IL")} תנועות`}
            </button>
            {showTransactionsRange && !loading && (
              <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700 shadow-lg">
                <div className="space-y-1">
                  <div className="text-slate-500">הפרש בין העסקה הראשונה לאחרונה</div>
                  <div className="font-semibold">{transactionRangeLabel}</div>
                </div>
              </div>
            )}
          </div>
          <div
            className="relative text-sm font-semibold text-slate-900"
            onMouseEnter={() => setShowTotalsBreakdown(true)}
            onMouseLeave={() => setShowTotalsBreakdown(false)}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              onFocus={() => setShowTotalsBreakdown(true)}
              onBlur={() => setShowTotalsBreakdown(false)}
            >
              <span>סכום כולל:</span>
              <span className="inline-block tabular-nums text-right" dir="ltr">
                {formatILS(totalAmount)}
              </span>
            </button>
            {showTotalsBreakdown && (
              <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-lg">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">יתרת פתיחה</span>
                    <span
                      className={`tabular-nums ${
                        openingBalance >= 0 ? "text-emerald-600" : "text-red-600"
                      }`}
                      dir="ltr"
                    >
                      {formatILS(openingBalance)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-emerald-600">+</span>
                    <span className="flex-1 text-right text-slate-500">הכנסות</span>
                    <span className="tabular-nums text-emerald-600" dir="ltr">
                      {formatILS(incomeTotal)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-red-600">-</span>
                    <span className="flex-1 text-right text-slate-500">הוצאות</span>
                    <span className="tabular-nums text-red-600" dir="ltr">
                      {formatILS(expenseTotal)}
                    </span>
                  </div>
                  <div className="border-t border-dashed border-slate-200 pt-2">
                    <div className="flex items-center justify-between gap-2 font-semibold">
                      <span className="text-slate-500">סה&quot;כ</span>
                      <span
                        className={`tabular-nums ${
                          totalAmount >= 0 ? "text-emerald-600" : "text-red-600"
                        }`}
                        dir="ltr"
                      >
                        {formatILS(totalAmount)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
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
                localStorage.setItem(
                  TRANSACTIONS_PAGE_SIZE_PREFERENCE_STORAGE_KEY,
                  String(nextSize)
                );
              }}
            >
              {TRANSACTIONS_PAGE_SIZE_OPTIONS.map((size) => (
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
        rows={rowsWithOpeningBalance} 
        categories={categories} 
        tags={tags}
        sortConfig={sortConfig}
        onSortChange={handleSortChange}
        onUpdateCategory={onUpdateCategory}
        onUpdateTags={onUpdateTags}
        onBulkUpdateCategory={onBulkUpdateCategory}
        onBulkUpdateTags={onBulkUpdateTags}
        onFilterByDescription={onFilterByDescription}
        onFilterByDirection={onFilterByDirection}
        onFilterByMonth={onFilterByMonth}
        onRefreshTransactions={handleRefreshTransactions}
        isRefreshingTransactions={isRefreshingTransactions}
      />
    </div>
  );
}
