import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { apiGet, apiPatch, apiPost } from "../api.js";
import { TransactionDetailsDialog } from "../components/TransactionsTable.jsx";
import { formatDateDMY, formatILS, isoMonthStart, isoToday, parseDateDMY } from "../utils/format.js";
import { formatSourceLabel } from "../utils/source.js";
import {
  TRANSACTIONS_PAGE_SIZE_OPTIONS,
  TRANSACTIONS_RANGE_OPTIONS,
  getTransactionsDateRange,
  resolveTransactionsPageSizeOption,
  resolveTransactionsRangeOption,
} from "../utils/transactions.js";

const PAGE_SIZE_STORAGE_KEY = "transactions.workspace.pageSize.preference";
const DETAILS_PANEL_COLLAPSED_STORAGE_KEY = "transactions.workspace.detailsPanel.collapsed";
const FILTERS_PANEL_COLLAPSED_STORAGE_KEY = "transactions.workspace.filtersPanel.collapsed";

// New daily workspace for searching, filtering, balance review, and transaction marking.
export default function TransactionsWorkspace() {
  const defaultPageSizeOption = resolveTransactionsPageSizeOption(
    localStorage.getItem(PAGE_SIZE_STORAGE_KEY) || "50"
  ) || TRANSACTIONS_PAGE_SIZE_OPTIONS[2];
  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [sources, setSources] = useState([]);
  const [rules, setRules] = useState([]);
  const [rows, setRows] = useState([]);
  const [timelineRows, setTimelineRows] = useState([]);
  const [latestBalance, setLatestBalance] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [categoryEditor, setCategoryEditor] = useState(null);
  const [selectedRows, setSelectedRows] = useState(new Set());
  const [tagsEditor, setTagsEditor] = useState(null);
  const [detailsTransaction, setDetailsTransaction] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [rulePicker, setRulePicker] = useState(null);
  const [rulePickerSearch, setRulePickerSearch] = useState("");
  const [selectedRuleToUpdate, setSelectedRuleToUpdate] = useState("");
  const [ruleEditor, setRuleEditor] = useState(null);
  const [ruleForm, setRuleForm] = useState({
    name: "",
    match_field: "merchant",
    match_type: "contains",
    pattern: "",
    source: "",
    direction: "",
    category_id: "",
    tag_ids: [],
  });
  const [ruleTagsOpen, setRuleTagsOpen] = useState(false);
  const [runCreatedRule, setRunCreatedRule] = useState(false);
  const [createdRuleScope, setCreatedRuleScope] = useState("uncategorized");
  const [clearExistingTagsOnApply, setClearExistingTagsOnApply] = useState(false);
  const [isCreatingRule, setIsCreatingRule] = useState(false);
  const [isApplyingRule, setIsApplyingRule] = useState(false);
  const [isApplyingTags, setIsApplyingTags] = useState(false);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSizeOption.pageSize);
  const [pageSizeOption, setPageSizeOption] = useState(defaultPageSizeOption.value);
  const [rangeOption, setRangeOption] = useState("custom");
  const [showTotalsBreakdown, setShowTotalsBreakdown] = useState(false);
  const [showTransactionsRange, setShowTransactionsRange] = useState(false);
  const [showHiddenTransactions, setShowHiddenTransactions] = useState(false);
  const [includeExcludedFromCalculations, setIncludeExcludedFromCalculations] = useState(false);
  const [isRefreshingTransactions, setIsRefreshingTransactions] = useState(false);
  const [showScrollTopButton, setShowScrollTopButton] = useState(false);
  const [detailsPanelCollapsed, setDetailsPanelCollapsed] = useState(localStorage.getItem(DETAILS_PANEL_COLLAPSED_STORAGE_KEY) === "1");
  const [filtersPanelCollapsed, setFiltersPanelCollapsed] = useState(localStorage.getItem(FILTERS_PANEL_COLLAPSED_STORAGE_KEY) === "1");
  const [allTransactionsRange, setAllTransactionsRange] = useState({ minDate: null, maxDate: null });
  const [data, setData] = useState({
    total: 0,
    totalAmount: 0,
    openingBalance: 0,
    incomeTotal: 0,
    expenseTotal: 0,
    dateRange: { minDate: null, maxDate: null },
  });
  const [filters, setFilters] = useState({
    from: isoMonthStart(),
    to: isoToday(),
    q: "",
    source: "",
    categoryId: "",
    direction: "",
    tagIds: [],
    untagged: "0",
    uncategorized: "0",
  });
  const [sortConfig, setSortConfig] = useState({ key: "chronological_index", direction: "desc" });
  const activeLoadId = useRef(0);
  const menuRef = useRef(null);
  const ruleTagsRef = useRef(null);
  const pendingGraphScrollId = useRef(null);

  useEffect(() => {
    let isMounted = true;
    apiGet("/api/stats/date-range")
      .then((range) => {
        if (!isMounted) return;
        setAllTransactionsRange({
          minDate: range?.minDate || null,
          maxDate: range?.maxDate || null,
        });
      })
      .catch(console.error);
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    load().catch(console.error);
  }, [JSON.stringify(filters), JSON.stringify(sortConfig), page, pageSize, includeExcludedFromCalculations]);

  useEffect(() => {
    const selectableIds = new Set(rows.map((row) => row.id));
    setSelectedRows((current) => new Set([...current].filter((id) => selectableIds.has(id))));
  }, [rows]);

  useEffect(() => {
    function closeContextMenu() {
      setContextMenu(null);
    }
    if (contextMenu) {
      document.addEventListener("click", closeContextMenu);
      return () => document.removeEventListener("click", closeContextMenu);
    }
  }, [contextMenu]);

  useEffect(() => {
    function updateScrollTopButton() {
      setShowScrollTopButton(window.scrollY > 90);
    }
    updateScrollTopButton();
    window.addEventListener("scroll", updateScrollTopButton, { passive: true });
    return () => window.removeEventListener("scroll", updateScrollTopButton);
  }, []);

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) {
      return;
    }

    const rect = menuRef.current.getBoundingClientRect();
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxY = Math.max(margin, window.innerHeight - rect.height - margin);
    const nextX = Math.min(Math.max(contextMenu.x, margin), maxX);
    const nextY = Math.min(Math.max(contextMenu.y, margin), maxY);

    setContextMenu((current) => {
      if (!current || (current.x === nextX && current.y === nextY)) {
        return current;
      }
      return { ...current, x: nextX, y: nextY };
    });
  }, [contextMenu]);

  useEffect(() => {
    function closeRuleTags(event) {
      if (ruleTagsRef.current && !ruleTagsRef.current.contains(event.target)) {
        setRuleTagsOpen(false);
      }
    }
    if (ruleTagsOpen) {
      document.addEventListener("mousedown", closeRuleTags);
      return () => document.removeEventListener("mousedown", closeRuleTags);
    }
  }, [ruleTagsOpen]);

  async function load() {
    const loadId = ++activeLoadId.current;
    setLoading(true);
    try {
      const listQs = buildTransactionQuery({ page, pageSize, sort: getSortParam(sortConfig) });
      const timelineQs = buildTransactionQuery({ page: 1, pageSize: 120, sort: "chronological_index_asc" });
      const latestQs = new URLSearchParams({ page: "1", pageSize: "1", sort: "chronological_index_desc" }).toString();
      const [categoryRes, tagRes, sourceRes, ruleRes, listRes, timelineRes, latestRes] = await Promise.all([
        apiGet("/api/categories"),
        apiGet("/api/tags"),
        apiGet("/api/sources"),
        apiGet("/api/rules"),
        apiGet(`/api/transactions?${listQs}`),
        apiGet(`/api/transactions?${timelineQs}`),
        apiGet(`/api/transactions?${latestQs}`),
      ]);

      if (loadId !== activeLoadId.current) return;
      setCategories(categoryRes.items || []);
      setTags(tagRes.items || []);
      setSources(sourceRes.items || []);
      setRules(ruleRes.items || []);
      setRows(listRes.rows || []);
      setTimelineRows(timelineRes.rows || []);
      setLatestBalance(Number(latestRes.rows?.[0]?.balance_amount || 0));
      setData(listRes);
      setSelectedId((current) => current || listRes.rows?.[0]?.id || null);
    } finally {
      if (loadId === activeLoadId.current) {
        setLoading(false);
      }
    }
  }

  function buildTransactionQuery({ page, pageSize, sort }) {
    const categoryId = filters.uncategorized === "1" ? "" : filters.categoryId;
    return new URLSearchParams({
      from: filters.from || "",
      to: filters.to || "",
      q: filters.q || "",
      source: filters.source || "",
      categoryId: categoryId || "",
      tagIds: filters.tagIds.join(","),
      direction: filters.direction || "",
      untagged: filters.untagged || "0",
      uncategorized: filters.uncategorized || "0",
      includeExcludedFromCalculations: includeExcludedFromCalculations ? "1" : "0",
      page: String(page),
      pageSize: String(pageSize),
      sort,
    }).toString();
  }

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

  const hiddenTagIds = useMemo(
    () => new Set(tags.filter((tag) => tag.hide_from_transactions).map((tag) => tag.id)),
    [tags]
  );
  const excludedFromCalculationsTagIds = useMemo(
    () => new Set(tags.filter((tag) => tag.exclude_from_calculations).map((tag) => tag.id)),
    [tags]
  );
  const activeTagFilterIds = useMemo(
    () => new Set(filters.tagIds.map(Number).filter((value) => !Number.isNaN(value))),
    [filters.tagIds]
  );
  function filterRowsForVisibility(candidateRows) {
    if (showHiddenTransactions || hiddenTagIds.size === 0) return candidateRows;
    return candidateRows.filter((row) => {
      const rowTagIds = parseTagIds(row.tags);
      return !rowTagIds.some((tagId) => hiddenTagIds.has(tagId) && !activeTagFilterIds.has(tagId));
    });
  }

  const visibleRows = useMemo(() => filterRowsForVisibility(rows), [rows, showHiddenTransactions, hiddenTagIds, activeTagFilterIds]);

  const selectedTransaction = useMemo(() => {
    return visibleRows.find((row) => isSameTransactionId(row.id, selectedId)) || visibleRows[0] || null;
  }, [visibleRows, selectedId]);

  useEffect(() => {
    const transactionId = pendingGraphScrollId.current;
    if (!transactionId || !visibleRows.some((row) => isSameTransactionId(row.id, transactionId))) return;
    pendingGraphScrollId.current = null;
    scrollTransactionRowIntoView(transactionId);
  }, [visibleRows]);

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
  const selectedSummary = useMemo(() => {
    const selected = visibleRows.filter((row) => selectedRows.has(row.id));
    const count = selected.length;
    const total = selected.reduce((sum, row) => sum + Number(row.amount_signed || 0), 0);
    return { count, total, average: count ? total / count : 0 };
  }, [visibleRows, selectedRows]);

  const filteredRulePickerRules = useMemo(() => {
    const query = rulePickerSearch.trim().toLowerCase();
    if (!query) return rules;
    const tagLookup = new Map(tags.map((tag) => [tag.id, tag.name_he]));
    return rules.filter((rule) => {
      const ruleTagNames = parseTagIds(rule.tag_ids).map((id) => tagLookup.get(id)).filter(Boolean).join(" ");
      return [
        rule.name,
        rule.pattern,
        rule.category_name,
        ruleTagNames,
        rule.source ? formatSourceLabel(rule.source) : "",
        rule.match_field,
      ].some((value) => String(value || "").toLowerCase().includes(query));
    });
  }, [rules, rulePickerSearch, tags]);

  const estimatedForecastBalance = useMemo(() => {
    const rangeNet = Number(data.totalAmount || 0);
    const start = filters.from ? new Date(`${filters.from}T00:00:00`) : null;
    const end = filters.to ? new Date(`${filters.to}T00:00:00`) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return latestBalance;
    }
    const days = Math.max(1, Math.ceil((end - start) / 86400000) + 1);
    const remaining = Math.max(0, new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate() - end.getDate());
    return latestBalance + (rangeNet / days) * remaining;
  }, [data.totalAmount, filters.from, filters.to, latestBalance]);

  const totalPages = Math.max(1, Math.ceil(Number(data.total || 0) / pageSize));
  const currentPage = Math.max(1, Number(data.page || page) || 1);
  const paginationPages = Math.max(totalPages, currentPage);
  const paginationButtonClass = "btn disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-slate-100";
  const allSelected = visibleRows.length > 0 && visibleRows.every((row) => selectedRows.has(row.id));

  function scrollTransactionRowIntoView(transactionId) {
    requestAnimationFrame(() => {
      document.querySelector(`[data-transaction-row-id="${transactionId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  async function focusGraphTransaction(transactionId) {
    const targetId = transactionId;
    if (targetId == null || String(targetId) === "forecast") return;

    setSelectedId(targetId);
    setCategoryEditor(null);
    setTagsEditor(null);
    pendingGraphScrollId.current = targetId;

    if (visibleRows.some((row) => isSameTransactionId(row.id, targetId))) {
      pendingGraphScrollId.current = null;
      scrollTransactionRowIntoView(targetId);
      return;
    }

    const lookupPageSize = 1000;

    try {
      let lookupPage = 1;
      while (true) {
        const result = await apiGet(`/api/transactions?${buildTransactionQuery({ page: lookupPage, pageSize: lookupPageSize, sort: getSortParam(sortConfig) })}`);
        const lookupRows = result.rows || [];
        const rowIndex = lookupRows.findIndex((row) => isSameTransactionId(row.id, targetId));
        if (rowIndex >= 0) {
          const absoluteIndex = (lookupPage - 1) * lookupPageSize + rowIndex;
          setPage(Math.floor(absoluteIndex / pageSize) + 1);
          return;
        }
        if (lookupRows.length < lookupPageSize) break;
        lookupPage += 1;
      }

      pendingGraphScrollId.current = null;
      toast.error("לא ניתן למצוא את התנועה בסינון הנוכחי");
    } catch (error) {
      pendingGraphScrollId.current = null;
      console.error("Failed to locate graph transaction in table:", error);
      toast.error("שגיאה באיתור התנועה בטבלה");
    }
  }
  function updateFilter(patch) {
    setPage(1);
    setFilters((current) => ({ ...current, ...patch }));
  }

  function applyPageSize(value) {
    const option = resolveTransactionsPageSizeOption(value);
    if (!option) return;
    setPage(1);
    setPageSize(option.pageSize);
    setPageSizeOption(option.value);
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, option.value);
  }

  function applyRangeOption(value) {
    setRangeOption(value);
    setPage(1);
    if (value === "custom") return;
    if (value === "all") {
      if (allTransactionsRange.minDate && allTransactionsRange.maxDate) {
        updateFilter({ from: allTransactionsRange.minDate, to: allTransactionsRange.maxDate });
      }
      return;
    }
    const option = resolveTransactionsRangeOption(value);
    const range = getTransactionsDateRange(option);
    if (range) {
      updateFilter({ from: range.from, to: range.to });
    }
  }

  function handleManualDateChange(patch) {
    setRangeOption("custom");
    updateFilter(patch);
  }

  function parseTagIds(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(Number).filter((value) => !Number.isNaN(value));
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(Number).filter((value) => !Number.isNaN(value));
    } catch {
      // Keep supporting comma-separated legacy values.
    }
    return String(value).split(",").map((item) => Number(item.trim())).filter((value) => !Number.isNaN(value));
  }

  function tagNames(value) {
    const lookup = new Map(tags.map((tag) => [tag.id, tag.name_he]));
    return parseTagIds(value).map((id) => lookup.get(id)).filter(Boolean);
  }

  function tagItems(value) {
    const lookup = new Map(tags.map((tag) => [tag.id, tag]));
    return parseTagIds(value).map((id) => lookup.get(id)).filter(Boolean);
  }

  function handleSort(columnKey) {
    setPage(1);
    setSortConfig((current) => {
      if (current.key === columnKey) {
        return { key: columnKey, direction: current.direction === "asc" ? "desc" : "asc" };
      }
      return { key: columnKey, direction: "asc" };
    });
  }

  function toggleRowSelection(rowId) {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }

  function toggleAllRows() {
    if (allSelected) {
      setSelectedRows(new Set());
      return;
    }
    setSelectedRows(new Set(visibleRows.map((row) => row.id)));
  }

  async function updateSelectedCategory(categoryId) {
    if (!selectedTransaction) return;
    await apiPatch(`/api/transactions/${selectedTransaction.id}`, { category_id: categoryId ? Number(categoryId) : null });
    toast.success("הקטגוריה עודכנה");
    await load();
  }

  function openCategoryEditor(transaction) {
    setTagsEditor(null);
    setCategoryEditor({ transactionId: transaction.id, selectedCategoryId: transaction.category_id ? String(transaction.category_id) : "" });
  }

  function selectEditedCategory(categoryId) {
    setCategoryEditor((current) => current ? { ...current, selectedCategoryId: categoryId } : current);
  }

  async function applyEditedCategory() {
    if (!categoryEditor) return;
    await apiPatch(`/api/transactions/${categoryEditor.transactionId}`, { category_id: categoryEditor.selectedCategoryId ? Number(categoryEditor.selectedCategoryId) : null });
    toast.success("הקטגוריה עודכנה");
    setCategoryEditor(null);
    await load();
  }

  async function updateSelectedTags(values) {
    if (!selectedTransaction) return;
    await apiPatch(`/api/transactions/${selectedTransaction.id}`, { tags: values.map(Number) });
    toast.success("התגיות עודכנו");
    await load();
  }

  function openTagsEditor(transaction) {
    setCategoryEditor(null);
    setTagsEditor({ transactionId: transaction.id, selectedTagIds: parseTagIds(transaction.tags) });
  }

  function toggleEditedTag(tagId) {
    setTagsEditor((current) => {
      if (!current) return current;
      const next = new Set(current.selectedTagIds.map(Number));
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return { ...current, selectedTagIds: Array.from(next) };
    });
  }

  async function applyEditedTags() {
    if (!tagsEditor) return;
    setIsApplyingTags(true);
    try {
      await apiPatch(`/api/transactions/${tagsEditor.transactionId}`, { tags: tagsEditor.selectedTagIds.map(Number) });
      toast.success("התגיות עודכנו");
      setTagsEditor(null);
      await load();
    } catch (error) {
      console.error("Failed to update transaction tags:", error);
      toast.error("שגיאה בעדכון התגיות");
    } finally {
      setIsApplyingTags(false);
    }
  }

  async function bulkUpdateCategory(categoryId) {
    if (selectedRows.size === 0) return;
    const categoryName = categoryId ? categories.find((category) => category.id === Number(categoryId))?.name_he : null;
    if (!confirmBulkAction(categoryName ? `לעדכן את הקטגוריה ל-${categoryName}` : "לנקות את הקטגוריה")) return;
    await Promise.all([...selectedRows].map((id) => apiPatch(`/api/transactions/${id}`, { category_id: categoryId ? Number(categoryId) : null })));
    toast.success("הקטגוריה עודכנה לתנועות שנבחרו");
    await load();
  }

  async function bulkAddTag(tagId) {
    if (!tagId || selectedRows.size === 0) return;
    const tagName = tags.find((tag) => tag.id === Number(tagId))?.name_he;
    if (!confirmBulkAction(`להוסיף את התג ${tagName || ""}`.trim())) return;
    const updates = visibleRows
      .filter((row) => selectedRows.has(row.id))
      .map((row) => {
        const existing = parseTagIds(row.tags);
        return { id: row.id, tags: existing.includes(Number(tagId)) ? existing : [...existing, Number(tagId)] };
      });
    await Promise.all(updates.map((update) => apiPatch(`/api/transactions/${update.id}`, { tags: update.tags })));
    toast.success("התג נוסף לתנועות שנבחרו");
    await load();
  }

  async function bulkRemoveTag(tagId) {
    if (!tagId || selectedRows.size === 0) return;
    const tagIdNumber = Number(tagId);
    const tagName = tags.find((tag) => tag.id === tagIdNumber)?.name_he;
    if (!confirmBulkAction(`להסיר את התג ${tagName || ""}`.trim())) return;
    const updates = visibleRows
      .filter((row) => selectedRows.has(row.id))
      .map((row) => ({ id: row.id, tags: parseTagIds(row.tags).filter((id) => id !== tagIdNumber) }));
    await Promise.all(updates.map((update) => apiPatch(`/api/transactions/${update.id}`, { tags: update.tags })));
    toast.success("התג הוסר מהתנועות שנבחרו");
    await load();
  }

  async function bulkClearTags() {
    if (selectedRows.size === 0) return;
    if (!confirmBulkAction("לנקות את כל התגיות")) return;
    await Promise.all([...selectedRows].map((id) => apiPatch(`/api/transactions/${id}`, { tags: [] })));
    toast.success("התגיות הוסרו מהתנועות שנבחרו");
    await load();
  }

  function confirmBulkAction(actionText) {
    return window.confirm(`${actionText} בתנועות שנבחרו.\n\nהפעולה תחול על ${selectedRows.size} תנועות.\nלא ניתן לבטל את הפעולה.\n\nהאם להמשיך?`);
  }

  async function refreshTransactions() {
    if (isRefreshingTransactions) return;
    setIsRefreshingTransactions(true);
    try {
      await apiPost("/api/transactions/reindex");
      await load();
      toast.success("הסדר והיתרות עודכנו");
    } catch (error) {
      console.error(error);
      toast.error("לא ניתן לעדכן את התנועות כרגע");
    } finally {
      setIsRefreshingTransactions(false);
    }
  }

  async function exportCsv() {
    const exportPageSize = 200;
    try {
      const firstPage = await apiGet(`/api/transactions?${buildTransactionQuery({ page: 1, pageSize: exportPageSize, sort: getSortParam(sortConfig) })}`);
      const totalExportPages = Math.max(1, Math.ceil(Number(firstPage.total || 0) / exportPageSize));
      const exportRows = [...(firstPage.rows || [])];

      for (let exportPage = 2; exportPage <= totalExportPages; exportPage += 1) {
        const pageResult = await apiGet(`/api/transactions?${buildTransactionQuery({ page: exportPage, pageSize: exportPageSize, sort: getSortParam(sortConfig) })}`);
        exportRows.push(...(pageResult.rows || []));
      }

      const rowsToExport = filterRowsForVisibility(exportRows);
      if (rowsToExport.length === 0) {
        toast.error("אין תנועות לייצוא");
        return;
      }

      const csvContent = buildCsv(rowsToExport, tags, categories);
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `transactions-${filters.from || "start"}-${filters.to || "end"}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      toast.error("לא ניתן לייצא את התנועות כרגע");
    }
  }

  function getRulePattern(transaction, matchField) {
    if (matchField === "category_raw") {
      return transaction.category_raw || "";
    }
    return transaction.merchant || transaction.description || "";
  }

  function escapeRegexText(value) {
    return String(value || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildUpdatedRulePattern(rule, description) {
    const nextDescription = escapeRegexText(description);
    if (!nextDescription) return String(rule.pattern || "").trim();
    if (rule.match_type === "regex") {
      const existingPattern = String(rule.pattern || "").trim();
      return existingPattern ? `${existingPattern}|${nextDescription}` : nextDescription;
    }
    const existingPattern = escapeRegexText(rule.pattern);
    if (!existingPattern || existingPattern === nextDescription) return nextDescription;
    return `${existingPattern}|${nextDescription}`;
  }

  function openExistingRulePicker(transaction) {
    const description = getRulePattern(transaction, "merchant");
    if (!description) {
      toast.error("לא ניתן להוסיף לחוק - אין תיאור או בית עסק");
      return;
    }
    setRulePicker({ transaction, description });
    setRulePickerSearch("");
    setSelectedRuleToUpdate("");
    setContextMenu(null);
  }

  function openExistingRuleEditor() {
    const rule = rules.find((item) => item.id === Number(selectedRuleToUpdate));
    if (!rule || !rulePicker) return;
    setRuleForm({
      name: rule.name || "",
      match_field: rule.match_field || "merchant",
      match_type: "regex",
      pattern: buildUpdatedRulePattern(rule, rulePicker.description),
      source: rule.source || "",
      direction: rule.direction || "",
      category_id: rule.category_id ? String(rule.category_id) : "",
      tag_ids: parseTagIds(rule.tag_ids),
    });
    setRuleTagsOpen(false);
    setRunCreatedRule(false);
    setCreatedRuleScope("uncategorized");
    setClearExistingTagsOnApply(false);
    setRuleEditor({ transactionId: rulePicker.transaction.id, ruleId: rule.id, mode: "edit" });
    setRulePicker(null);
  }

  function showTransactionDetailsFromContextMenu(transaction) {
    setSelectedId(transaction.id);
    setDetailsTransaction(transaction);
    setContextMenu(null);
  }

  function openRuleEditor(transaction, matchField) {
    const pattern = getRulePattern(transaction, matchField);

    if (!pattern) {
      toast.error(
        matchField === "category_raw"
          ? "לא ניתן לקבוע חוק - אין תיאור מחברת האשראי"
          : "לא ניתן לקבוע חוק - אין תיאור או בית עסק"
      );
      return;
    }

    const tagIds = parseTagIds(transaction.tags);
    const categoryLabel = categories.find((category) => category.id === transaction.category_id)?.name_he;
    const suffix = categoryLabel || (tagIds.length > 0 ? "תגיות" : "חוק");

    setRuleForm({
      name: `${pattern} → ${suffix}`,
      match_field: matchField,
      match_type: "contains",
      pattern,
      source: "",
      direction: transaction.direction || "",
      category_id: transaction.category_id ? String(transaction.category_id) : "",
      tag_ids: tagIds,
    });
    setRuleTagsOpen(false);
    setRunCreatedRule(false);
    setCreatedRuleScope("uncategorized");
    setClearExistingTagsOnApply(false);
    setRuleEditor({ transactionId: transaction.id });
    setContextMenu(null);
  }


  async function submitRule() {
    setIsCreatingRule(true);

    try {
      const payload = {
        name: ruleForm.name.trim(),
        match_field: ruleForm.match_field,
        match_type: ruleForm.match_type,
        pattern: ruleForm.pattern.trim(),
        source: ruleForm.source || null,
        direction: ruleForm.direction || null,
        category_id: ruleForm.category_id ? Number(ruleForm.category_id) : null,
        tag_ids: ruleForm.tag_ids,
      };
      const isEditingRule = ruleEditor?.mode === "edit" && ruleEditor?.ruleId;
      const savedRule = isEditingRule
        ? await apiPatch(`/api/rules/${ruleEditor.ruleId}`, payload)
        : await apiPost("/api/rules", payload);
      const savedRuleId = isEditingRule ? ruleEditor.ruleId : savedRule?.item?.id;
      if (runCreatedRule && savedRuleId) {
        setIsApplyingRule(true);
        try {
          const result = await apiPost(`/api/rules/${savedRuleId}/apply`, {
            scope: createdRuleScope,
            clear_existing_tags: clearExistingTagsOnApply,
          });
          const applyData = result?.data ?? result;
          const actionLabel = isEditingRule ? "עודכן והופעל" : "נוצר והופעל";
          if (createdRuleScope === "all") {
            toast.success(`חוק ${actionLabel}: עודכנו ${applyData.updated_total ?? applyData.updated} מתוך ${applyData.scanned} תנועות`);
          } else if (createdRuleScope === "categorized") {
            toast.success(`חוק ${actionLabel}: עודכנו ${applyData.updated_total ?? applyData.updated} מתוך ${applyData.scanned} תנועות מסווגות`);
          } else if (createdRuleScope === "cancel_categorized") {
            toast.success(`חוק ${isEditingRule ? "עודכן ובוטל" : "נוצר ובוטל"}: בוטלו ${applyData.cleared ?? 0} תנועות מסווגות`);
          } else {
            toast.success(`חוק ${actionLabel}: סווגו ${applyData.updated} מתוך ${applyData.scanned} תנועות`);
          }
          await load();
        } finally {
          setIsApplyingRule(false);
        }
      } else {
        toast.success(isEditingRule ? `חוק עודכן: "${ruleForm.pattern}"` : `חוק נוצר: "${ruleForm.pattern}"`);
      }
      setRuleEditor(null);
      setRuleTagsOpen(false);
      window.dispatchEvent(new CustomEvent("reload-rules"));
    } catch (error) {
      console.error("Failed to save rule:", error);
      toast.error("שגיאה בשמירת החוק");
    } finally {
      setIsCreatingRule(false);
    }
  }

  function toggleRuleTag(tagId) {
    const next = new Set(ruleForm.tag_ids);
    if (next.has(tagId)) {
      next.delete(tagId);
    } else {
      next.add(tagId);
    }
    setRuleForm({ ...ruleForm, tag_ids: Array.from(next) });
  }

  function openContextMenu(event, transaction) {
    event.preventDefault();
    setSelectedId(transaction.id);
    setContextMenu({ x: event.clientX, y: event.clientY, transaction });
  }

  function filterByTransactionText(transaction) {
    updateFilter({ q: transaction.merchant || transaction.description || "" });
    setContextMenu(null);
  }

  function filterByTransactionMonth(transaction) {
    if (!transaction.txn_date) return;
    const [year, month] = transaction.txn_date.split("-");
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    updateFilter({ from: `${year}-${month}-01`, to: `${year}-${month}-${String(lastDay).padStart(2, "0")}` });
    setRangeOption("custom");
    setContextMenu(null);
  }

  function toggleDetailsPanelCollapsed() {
    setDetailsPanelCollapsed((current) => {
      const next = !current;
      localStorage.setItem(DETAILS_PANEL_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  function toggleFiltersPanelCollapsed() {
    setFiltersPanelCollapsed((current) => {
      const next = !current;
      localStorage.setItem(FILTERS_PANEL_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  function scrollAllTheWayUp() {
    setShowScrollTopButton(false);
    window.scrollTo(0, 0);
  }

  return (
    <div className="space-y-4">
      {showScrollTopButton && (
        <button
          type="button"
          className="fixed right-4 top-4 z-50 flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-xl font-bold text-slate-700 shadow-lg hover:bg-slate-50"
          title="גלול עד למעלה"
          aria-label="גלול עד למעלה"
          onClick={scrollAllTheWayUp}
        >
          ↑
        </button>
      )}
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-950">תנועות</h1>
          <p className="text-sm text-slate-500">חיפוש, סינון, יתרה בכל נקודה וסימון תנועות במקום אחד</p>
        </div>
        <div className="text-xl font-bold text-slate-950 xl:self-center" dir="ltr">
          {formatDateDMY(filters.from) || "-"} - {formatDateDMY(filters.to) || "-"}
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Summary label="יתרה נוכחית" value={formatILS(latestBalance)} tone={latestBalance >= 0 ? "positive" : "negative"} />
          <Summary label="יתרה בתנועה" value={formatILS(selectedTransaction?.balance_amount ?? 0)} />
          <Summary label="תחזית ראשונית" value={formatILS(estimatedForecastBalance)} tone={estimatedForecastBalance >= 0 ? "positive" : "negative"} />
          <Summary label="תנועות בסינון" value={Number(data.total || 0).toLocaleString("he-IL")} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <main className="space-y-4">
          <div className="relative rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
            <div className="pointer-events-none absolute right-4 top-3 z-10">
              <h2 className="font-semibold text-slate-950">יתרה לאורך התנועות</h2>
              <div className="text-xs text-slate-500">בחירת שורה מעדכנת את יתרת הנקודה והפאנל הימני</div>
            </div>
            {loading && <div className="absolute left-4 top-3 z-10 text-xs text-slate-500">טוען...</div>}
            <BalanceTimeline rows={timelineRows} selectedId={selectedTransaction?.id} forecastValue={estimatedForecastBalance} onPointClick={focusGraphTransaction} />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-3">
              <div className="relative flex flex-wrap items-center gap-3 text-sm">
                <button
                  type="button"
                  className="font-semibold text-slate-900 underline decoration-dotted underline-offset-4"
                  onMouseEnter={() => setShowTotalsBreakdown(true)}
                  onMouseLeave={() => setShowTotalsBreakdown(false)}
                  onFocus={() => setShowTotalsBreakdown(true)}
                  onBlur={() => setShowTotalsBreakdown(false)}
                >
                  סה"כ: <span dir="ltr">{formatILS(data.totalAmount)}</span>
                </button>
                {showTotalsBreakdown && (
                  <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-lg">
                    <TotalsBreakdown data={data} />
                  </div>
                )}
                                <div
                  className="relative text-slate-500"
                  onMouseEnter={() => setShowTransactionsRange(true)}
                  onMouseLeave={() => setShowTransactionsRange(false)}
                >
                  <button
                    type="button"
                    className="hover:text-slate-700"
                    onFocus={() => setShowTransactionsRange(true)}
                    onBlur={() => setShowTransactionsRange(false)}
                  >
                    {Number(data.total || 0).toLocaleString("he-IL")} תנועות
                  </button>
                  {showTransactionsRange && !loading && (
                    <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700 shadow-lg">
                      <div className="space-y-1">
                        <div className="text-slate-500">הפרש בין העסקה הראשונה לאחרונה</div>
                        <div className="font-semibold">{transactionRangeLabel}</div>
                      </div>
                    </div>
                  )}
                </div>
                {selectedSummary.count > 0 && (
                  <span className="rounded-full bg-blue-50 px-3 py-1 text-blue-700">
                    נבחרו {selectedSummary.count} · סכום {formatILS(selectedSummary.total)} · ממוצע {formatILS(selectedSummary.average)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select className="select h-9 text-sm" value={pageSizeOption} onChange={(event) => applyPageSize(event.target.value)} aria-label="שורות להצגה">
                  {TRANSACTIONS_PAGE_SIZE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <IconButton label="רענן סדר תנועות ויתרות" onClick={refreshTransactions} disabled={isRefreshingTransactions}>{isRefreshingTransactions ? "⟳…" : "⟳"}</IconButton>
                <IconButton label="ייצוא התנועות ל-CSV" onClick={exportCsv}><img src="/excel-icon.png" alt="" className="h-5 w-5" aria-hidden="true" /></IconButton>
                <IconButton label="הצג תנועות מוסתרות" onClick={() => setShowHiddenTransactions((value) => !value)} disabled={hiddenTagIds.size === 0} active={showHiddenTransactions}>{showHiddenTransactions ? "👁️" : <span style={{ position: "relative", display: "inline-block" }}>👁️<span style={{ position: "absolute", top: "50%", left: "0", right: "0", height: "2px", backgroundColor: "currentColor", transform: "rotate(-45deg)" }} /></span>}</IconButton>
                <IconButton label="כלול תנועות שלא נכללות בחישובים" onClick={() => setIncludeExcludedFromCalculations((value) => !value)} disabled={excludedFromCalculationsTagIds.size === 0} active={includeExcludedFromCalculations}><span className="relative inline-block"><img src="/calc-icon.png" alt="" className="h-5 w-5" aria-hidden="true" />{!includeExcludedFromCalculations && <span className="absolute left-0 right-0 top-1/2 h-0.5 bg-current" style={{ transform: "rotate(-45deg)" }} />}</span></IconButton>
              </div>
            </div>

            <div className="overflow-visible">
              <table className="w-full min-w-[1040px] text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="sticky top-0 z-20 w-10 bg-slate-50 p-3 text-center shadow-[0_1px_0_0_rgba(226,232,240,1)]">
                      <input type="checkbox" checked={allSelected} onChange={toggleAllRows} aria-label="בחר את כל התנועות" />
                    </th>
                    <SortableHeader label="תאריך" columnKey="txn_date" sortConfig={sortConfig} onSort={handleSort} />
                    <SortableHeader label="תיאור" columnKey="description" sortConfig={sortConfig} onSort={handleSort} />
                    <SortableHeader label="סכום" columnKey="amount" sortConfig={sortConfig} onSort={handleSort} align="left" />
                    <SortableHeader label="יתרה אחרי" columnKey="balance" sortConfig={sortConfig} onSort={handleSort} align="left" />
                    <SortableHeader label="קטגוריה" columnKey="category" sortConfig={sortConfig} onSort={handleSort} />
                    <SortableHeader label="תגיות" columnKey="tags" sortConfig={sortConfig} onSort={handleSort} />
                    <th className="sticky top-0 z-20 bg-slate-50 p-3 text-right shadow-[0_1px_0_0_rgba(226,232,240,1)]">תחזית</th>
                    <SortableHeader label="מקור" columnKey="source" sortConfig={sortConfig} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRows.map((transaction) => {
                    const amount = Number(transaction.amount_signed || 0);
                    const selected = selectedTransaction?.id === transaction.id;
                    const rowTags = tagItems(transaction.tags);
                    const names = rowTags.map((tag) => tag.name_he);
                    const descriptionLabels = getTransactionDescriptionLabels(transaction);
                    return (
                      <tr
                        key={transaction.id}
                        data-transaction-row-id={transaction.id}
                        className={(selected ? "bg-blue-50 " : "") + "cursor-pointer hover:bg-slate-50"}
                        onClick={() => {
                          setSelectedId(transaction.id);
                          setCategoryEditor(null);
                        }}
                        onContextMenu={(event) => openContextMenu(event, transaction)}
                      >
                        <td className="p-3 text-center" onClick={(event) => event.stopPropagation()}>
                          <input type="checkbox" checked={selectedRows.has(transaction.id)} onChange={() => toggleRowSelection(transaction.id)} aria-label="בחר תנועה" />
                        </td>
                        <td className="p-3 whitespace-nowrap">{formatDateDMY(transaction.txn_date)}</td>
                        <td className="w-[15.5rem] max-w-[15.5rem] p-3" title={descriptionLabels.tooltip}>
                          <div className="truncate font-medium text-slate-900">{descriptionLabels.title}</div>
                          {descriptionLabels.secondary && <div className="truncate text-xs text-slate-500">{descriptionLabels.secondary}</div>}
                        </td>
                        <td className={(amount < 0 ? "text-red-600" : "text-emerald-600") + " p-3 text-left font-semibold whitespace-nowrap"} dir="ltr">{formatILS(amount)}</td>
                        <td className="p-3 text-left font-semibold whitespace-nowrap" dir="ltr">{transaction.balance_amount != null ? formatILS(transaction.balance_amount) : "-"}</td>
                        <td
                          className={(selected ? "cursor-pointer " : "") + "p-3 whitespace-nowrap"}
                          onClick={(event) => {
                            if (!selected) return;
                            event.stopPropagation();
                            openCategoryEditor(transaction);
                          }}
                        >
                          {transaction.category_name || "לא מסווג"}
                        </td>
                        <TransactionTagsCell tags={rowTags} editable={selected} onEdit={() => openTagsEditor(transaction)} />
                        <td className="p-3 text-slate-600 whitespace-nowrap">{resolveForecastLabel(transaction, names)}</td>
                        <td className="p-3 text-xs text-slate-500 whitespace-nowrap">{formatSourceLabel(transaction.source || "", { cardLast4: transaction.account_ref })}</td>
                      </tr>
                    );
                  })}
                  {visibleRows.length === 0 && (
                    <tr>
                      <td className="p-6 text-center text-slate-500" colSpan={9}>אין תנועות להצגה</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white p-3 text-sm text-slate-600 shadow-[0_-1px_0_0_rgba(226,232,240,1)]">
              <div className="flex items-center gap-2">
                <span>עמוד</span>
                <select className="select h-9 text-sm" value={currentPage} onChange={(event) => setPage(Number(event.target.value))} aria-label="מעבר לעמוד">
                  {Array.from({ length: paginationPages }, (_, index) => index + 1).map((pageNumber) => (
                    <option key={pageNumber} value={pageNumber}>{pageNumber}</option>
                  ))}
                </select>
                <span>מתוך {paginationPages}</span>
              </div>
              <div className="flex gap-2">
                <button className={paginationButtonClass} disabled={paginationPages <= 1 || currentPage <= 1} onClick={() => setPage(Math.max(1, currentPage - 1))}>הקודם</button>
                <button className={paginationButtonClass} disabled={paginationPages <= 1 || currentPage >= paginationPages} onClick={() => setPage(Math.min(paginationPages, currentPage + 1))}>הבא</button>
              </div>
            </div>
          </div>
        </main>

        <aside className="space-y-4">
          {filtersPanelCollapsed ? (
            <div className="sticky top-0 z-10 space-y-4">
              <SelectedTransactionPanel
                transaction={selectedTransaction}
                categories={categories}
                tags={tags}
                tagIds={parseTagIds(selectedTransaction?.tags)}
                tagNames={tagNames(selectedTransaction?.tags)}
                selectedCount={selectedSummary.count}
                collapsed={detailsPanelCollapsed}
                onToggleCollapsed={toggleDetailsPanelCollapsed}
                onCategoryChange={updateSelectedCategory}
                onTagsChange={updateSelectedTags}
                onMoreDetails={() => setDetailsTransaction(selectedTransaction)}
                onBulkCategoryChange={bulkUpdateCategory}
                onBulkTagAdd={bulkAddTag}
                onBulkTagRemove={bulkRemoveTag}
                onBulkTagsClear={bulkClearTags}
              />
              <FiltersPanel
                filters={filters}
                rangeOption={rangeOption}
                sources={sources}
                categories={categories}
                tags={tags}
                collapsed={filtersPanelCollapsed}
                onToggleCollapsed={toggleFiltersPanelCollapsed}
                onFilter={updateFilter}
                onRange={applyRangeOption}
                onManualDate={handleManualDateChange}
              />
            </div>
          ) : (
            <>
              <SelectedTransactionPanel
                transaction={selectedTransaction}
                categories={categories}
                tags={tags}
                tagIds={parseTagIds(selectedTransaction?.tags)}
                tagNames={tagNames(selectedTransaction?.tags)}
                selectedCount={selectedSummary.count}
                collapsed={detailsPanelCollapsed}
                onToggleCollapsed={toggleDetailsPanelCollapsed}
                onCategoryChange={updateSelectedCategory}
                onTagsChange={updateSelectedTags}
                onMoreDetails={() => setDetailsTransaction(selectedTransaction)}
                onBulkCategoryChange={bulkUpdateCategory}
                onBulkTagAdd={bulkAddTag}
                onBulkTagRemove={bulkRemoveTag}
                onBulkTagsClear={bulkClearTags}
              />
              <div className="sticky top-0 z-10">
                <FiltersPanel
                  filters={filters}
                  rangeOption={rangeOption}
                  sources={sources}
                  categories={categories}
                  tags={tags}
                  collapsed={filtersPanelCollapsed}
                  onToggleCollapsed={toggleFiltersPanelCollapsed}
                  onFilter={updateFilter}
                  onRange={applyRangeOption}
                  onManualDate={handleManualDateChange}
                />
              </div>
            </>
          )}
        </aside>
      </div>

      {detailsTransaction && (
        <TransactionDetailsDialog transaction={detailsTransaction} tags={tags} onClose={() => setDetailsTransaction(null)} />
      )}

      {categoryEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setCategoryEditor(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-slate-900">עריכת קטגוריה</div>
                <div className="text-sm text-slate-500">בחרו קטגוריה אחת שתישמר על התנועה.</div>
              </div>
              <button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100" onClick={() => setCategoryEditor(null)}>סגור</button>
            </div>
            <div className="mt-4 grid max-h-72 gap-2 overflow-y-auto rounded-xl border border-slate-300 bg-white p-2">
              <button
                type="button"
                className={(categoryEditor.selectedCategoryId === "" ? "border-slate-900 bg-slate-900 text-white " : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 ") + "rounded-full border px-3 py-2 text-right text-sm"}
                onClick={() => selectEditedCategory("")}
                aria-pressed={categoryEditor.selectedCategoryId === ""}
              >
                לא מסווג
              </button>
              {categories.map((category) => {
                const value = String(category.id);
                const selected = categoryEditor.selectedCategoryId === value;
                return (
                  <button
                    key={category.id}
                    type="button"
                    className={(selected ? "border-slate-900 bg-slate-900 text-white " : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 ") + "rounded-full border px-3 py-2 text-right text-sm"}
                    onClick={() => selectEditedCategory(value)}
                    aria-pressed={selected}
                  >
                    {category.icon ? `${category.icon} ` : ""}{category.name_he}
                  </button>
                );
              })}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setCategoryEditor(null)}>ביטול</button>
              <button type="button" className="btn" onClick={applyEditedCategory}>שמור שינויים</button>
            </div>
          </div>
        </div>
      )}

      {tagsEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setTagsEditor(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-slate-900">עריכת תגיות</div>
                <div className="text-sm text-slate-500">בחרו את התגיות שישארו על התנועה.</div>
              </div>
              <button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100" onClick={() => setTagsEditor(null)}>סגור</button>
            </div>
            <div className="mt-4">
              <TagToggleList tags={tags} selectedTagIds={tagsEditor.selectedTagIds} onToggle={toggleEditedTag} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setTagsEditor(null)}>ביטול</button>
              <button type="button" className="btn" onClick={applyEditedTags}>שמור שינויים</button>
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <div ref={menuRef} className="fixed z-50 w-64 rounded-xl border border-slate-200 bg-white p-1 text-sm shadow-lg" dir="rtl" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right hover:bg-slate-50" onClick={() => showTransactionDetailsFromContextMenu(contextMenu.transaction)}><span className="w-5 text-center text-slate-500">ⓘ</span><span>הצג פרטי תנועה</span></button>
          <div className="my-1 border-t border-slate-200" />
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right hover:bg-slate-50" onClick={() => filterByTransactionText(contextMenu.transaction)}><span className="w-5 text-center text-slate-500">⌕</span><span>סנן לפי תיאור דומה</span></button>
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right hover:bg-slate-50" onClick={() => updateFilter({ categoryId: contextMenu.transaction.category_id ? String(contextMenu.transaction.category_id) : "", uncategorized: contextMenu.transaction.category_id ? "0" : "1" })}><span className="w-5 text-center text-slate-500">▦</span><span>סנן לפי קטגוריה</span></button>
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right hover:bg-slate-50" onClick={() => filterByTransactionMonth(contextMenu.transaction)}><span className="w-5 text-center text-slate-500">◷</span><span>סנן לפי חודש</span></button>
          <div className="my-1 border-t border-slate-200" />
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right hover:bg-slate-50" onClick={() => openRuleEditor(contextMenu.transaction, "category_raw")}><span className="w-5 text-center text-slate-500">⚙</span><span>צור חוק מתיאור כ.אשראי</span></button>
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right hover:bg-slate-50" onClick={() => openRuleEditor(contextMenu.transaction, "merchant")}><span className="w-5 text-center text-slate-500">＋</span><span>צור חוק מתיאור זה</span></button>
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right hover:bg-slate-50" onClick={() => openExistingRulePicker(contextMenu.transaction)}><span className="w-5 text-center text-slate-500">↳</span><span>הוסף תיאור זה לחוק קיים</span></button>
        </div>
      )}

      {rulePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setRulePicker(null)}>
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-slate-900">הוספת תיאור לחוק קיים</div>
                <div className="text-sm text-slate-500">בחרו חוק אחד שאליו יתווסף התיאור: {rulePicker.description}</div>
              </div>
              <button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100" onClick={() => setRulePicker(null)}>סגור</button>
            </div>
            <input className="input mt-5 w-full" type="text" placeholder="חיפוש לפי שם חוק, תיאור, תבנית, קטגוריה או תגיות" value={rulePickerSearch} onChange={(event) => setRulePickerSearch(event.target.value)} />
            <div className="mt-3 max-h-80 overflow-y-auto rounded-xl border border-slate-200">
              {filteredRulePickerRules.map((rule) => {
                const selected = selectedRuleToUpdate === String(rule.id);
                const names = tagNames(rule.tag_ids);
                return (
                  <button
                    key={rule.id}
                    type="button"
                    className={(selected ? "bg-blue-50 ring-1 ring-blue-300 " : "") + "block w-full border-b border-slate-100 px-3 py-2 text-right hover:bg-slate-50 last:border-b-0"}
                    onClick={() => setSelectedRuleToUpdate(String(rule.id))}
                  >
                    <div className="font-medium text-slate-900">{rule.name}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {rule.match_field === "merchant" ? "תיאור/בית עסק" : rule.match_field === "category_raw" ? "תיאור חברת אשראי" : rule.match_field} {rule.match_type} "{rule.pattern}"
                      {rule.category_name ? ` → ${rule.category_name}` : ""}
                      {names.length > 0 ? ` · תגיות: ${names.join(", ")}` : ""}
                    </div>
                  </button>
                );
              })}
              {filteredRulePickerRules.length === 0 && <div className="px-3 py-6 text-center text-sm text-slate-500">לא נמצאו חוקים מתאימים.</div>}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setRulePicker(null)}>ביטול</button>
              <button type="button" className="btn" disabled={!selectedRuleToUpdate} onClick={openExistingRuleEditor}>בחר חוק זה</button>
            </div>
          </div>
        </div>
      )}

      {ruleEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setRuleEditor(null)}>
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-slate-900">{ruleEditor.mode === "edit" ? "עריכת חוק" : "יצירת חוק"}</div>
                <div className="text-sm text-slate-500">{ruleEditor.mode === "edit" ? "בדקו את הביטוי לפני עדכון החוק." : "התאימו את החוק לפני שמירה."}</div>
              </div>
              <button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100" onClick={() => setRuleEditor(null)}>סגור</button>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
              <input className="input md:col-span-2" type="text" placeholder="שם החוק" value={ruleForm.name} onChange={(event) => setRuleForm({ ...ruleForm, name: event.target.value })} />

              <select className="select" value={ruleForm.match_field} onChange={(event) => setRuleForm({ ...ruleForm, match_field: event.target.value })}>
                <option value="merchant">תיאור/בית עסק</option>
                <option value="description">תיאור</option>
                <option value="category_raw">תיאור חברת אשראי</option>
              </select>

              <select className="select" value={ruleForm.match_type} onChange={(event) => setRuleForm({ ...ruleForm, match_type: event.target.value })}>
                <option value="contains">כולל</option>
                <option value="equals">שווה</option>
                <option value="regex">רג׳קס</option>
              </select>

              <input className="input md:col-span-2" type="text" placeholder="ערך להתאמה" value={ruleForm.pattern} onChange={(event) => setRuleForm({ ...ruleForm, pattern: event.target.value })} />

              <select className="select" value={ruleForm.source} onChange={(event) => setRuleForm({ ...ruleForm, source: event.target.value })}>
                <option value="">כל המקורות</option>
                {sources.map((source) => <option key={source} value={source}>{formatSourceLabel(source)}</option>)}
              </select>

              <select className="select" value={ruleForm.direction} onChange={(event) => setRuleForm({ ...ruleForm, direction: event.target.value })}>
                <option value="">הכנסה+הוצאה</option>
                <option value="expense">הוצאה</option>
                <option value="income">הכנסה</option>
              </select>

              <select className="select md:col-span-2" value={ruleForm.category_id} onChange={(event) => setRuleForm({ ...ruleForm, category_id: event.target.value })}>
                <option value="">ללא קטגוריה</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.icon ? `${category.icon} ` : ""}{category.name_he}</option>)}
              </select>

              <div ref={ruleTagsRef} className="relative md:col-span-2">
                <button type="button" className="select flex w-full items-center justify-between" onClick={() => setRuleTagsOpen((open) => !open)} aria-expanded={ruleTagsOpen}>
                  <span className="truncate">{ruleForm.tag_ids.length > 0 ? `נבחרו ${ruleForm.tag_ids.length}` : "בחרו תגיות"}</span>
                  <span className="text-slate-400">▾</span>
                </button>
                {ruleTagsOpen && (
                  <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                    {tags.map((tag) => (
                      <label key={tag.id} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                        <input type="checkbox" checked={ruleForm.tag_ids.includes(tag.id)} onChange={() => toggleRuleTag(tag.id)} />
                        <span>{tag.icon ? `${tag.icon} ` : ""}{tag.name_he}</span>
                      </label>
                    ))}
                    {tags.length === 0 && <div className="px-3 py-2 text-sm text-slate-500">אין תגים</div>}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={runCreatedRule} onChange={(event) => setRunCreatedRule(event.target.checked)} />
                  <span>{ruleEditor.mode === "edit" ? "הרץ אחרי עדכון" : "הרץ אחרי יצירה"}</span>
                </label>
                <select className="select w-64" value={createdRuleScope} onChange={(event) => setCreatedRuleScope(event.target.value)} disabled={!runCreatedRule || isCreatingRule}>
                  <option value="all">הפעל חוקים על כל התנועות</option>
                  <option value="uncategorized">הפעל חוקים על לא-מסווגים</option>
                  <option value="categorized">הפעל חוקים על מסווגים</option>
                  <option value="cancel_categorized">בטל חוקים על מסווגים</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={clearExistingTagsOnApply} onChange={(event) => setClearExistingTagsOnApply(event.target.checked)} disabled={!runCreatedRule || isCreatingRule} />
                <span>נקה תגיות קיימות מתנועות שהחוק חל עליהן</span>
              </label>
              <div className="flex flex-wrap items-center justify-end gap-3">
                <button type="button" className="btn" onClick={() => setRuleEditor(null)}>ביטול</button>
                <button type="button" className="btn" disabled={isCreatingRule || !ruleForm.name.trim() || !ruleForm.pattern.trim() || (!ruleForm.category_id && ruleForm.tag_ids.length === 0)} onClick={submitRule}>{isCreatingRule ? (ruleEditor.mode === "edit" ? "מעדכן חוק..." : "יוצר חוק...") : (ruleEditor.mode === "edit" ? "עדכן חוק" : "צור חוק")}</button>
              </div>
            </div>

          </div>
        </div>
      )}
      {isApplyingRule && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-4">
          <div className="rounded-xl border border-slate-200 bg-white px-6 py-5 text-center shadow-xl">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900" />
            <div className="mt-4 text-lg font-semibold text-slate-900">מחילים חוק</div>
            <div className="mt-1 text-sm text-slate-600">פעולת החלת החוק מתבצעת כעת. בעוד רגע המסך יחזור להיות זמין.</div>
          </div>
        </div>
      )}
      {isApplyingTags && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-4">
          <div className="rounded-xl border border-slate-200 bg-white px-6 py-5 text-center shadow-xl">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900" />
            <div className="mt-4 text-lg font-semibold text-slate-900">מחילים תגיות</div>
            <div className="mt-1 text-sm text-slate-600">פעולת עדכון התגיות מתבצעת כעת. בעוד רגע המסך יחזור להיות זמין.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Summary({ label, value, tone = "neutral" }) {
  const color = tone === "positive" ? "text-emerald-600" : tone === "negative" ? "text-red-600" : "text-slate-950";
  return (
    <div className="min-w-40 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`${color} mt-1 text-lg font-bold`} dir="ltr">{value}</div>
    </div>
  );
}

function IconButton({ label, active = false, disabled = false, onClick, children }) {
  return (
    <button
      type="button"
      className={(active ? "bg-slate-900 text-white hover:bg-slate-800 " : "bg-white text-slate-700 hover:bg-slate-50 ") + "h-9 min-w-9 rounded-xl border border-slate-300 px-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function TotalsBreakdown({ data }) {
  return (
    <div className="space-y-2">
      <BreakdownRow label="תנועות" value={Number(data.total || 0).toLocaleString("he-IL")} />
      <BreakdownRow label="יתרת פתיחה" value={formatILS(data.openingBalance)} />
      <BreakdownRow label="הכנסות" value={formatILS(data.incomeTotal)} tone="positive" />
      <BreakdownRow label="הוצאות" value={formatILS(data.expenseTotal)} tone="negative" />
      <div className="border-t border-dashed border-slate-200 pt-2">
        <BreakdownRow label={'סה"כ'} value={formatILS(data.totalAmount)} tone={Number(data.totalAmount || 0) >= 0 ? "positive" : "negative"} strong />
      </div>
    </div>
  );
}

function BreakdownRow({ label, value, tone = "neutral", strong = false }) {
  const color = tone === "positive" ? "text-emerald-600" : tone === "negative" ? "text-red-600" : "text-slate-900";
  return (
    <div className={(strong ? "font-semibold " : "") + "flex items-center justify-between gap-3"}>
      <span className="text-slate-500">{label}</span>
      <span className={color} dir="ltr">{value}</span>
    </div>
  );
}

function BulkActions({ categories, tags, onCategory, onTag, onRemoveTag, onClearTags }) {
  function handleSelectAction(event, action) {
    const value = event.target.value;
    if (value) action(value);
    event.target.value = "";
  }

  return (
    <div className="mt-4 grid gap-2 text-sm">
      <select className="select h-9 w-full" defaultValue="" onChange={(event) => handleSelectAction(event, onCategory)}>
        <option value="">עדכן קטגוריה</option>
        {categories.map((category) => <option key={category.id} value={category.id}>{category.icon ? `${category.icon} ` : ""}{category.name_he}</option>)}
      </select>
      <select className="select h-9 w-full" defaultValue="" onChange={(event) => handleSelectAction(event, onTag)}>
        <option value="">הוסף תג</option>
        {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.icon ? `${tag.icon} ` : ""}{tag.name_he}</option>)}
      </select>
      <select className="select h-9 w-full" defaultValue="" onChange={(event) => handleSelectAction(event, onRemoveTag)}>
        <option value="">הסר תג</option>
        {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.icon ? `${tag.icon} ` : ""}{tag.name_he}</option>)}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <button className="btn justify-center" onClick={() => onCategory(null)}>נקה קטגוריה</button>
        <button className="btn justify-center" onClick={onClearTags}>נקה תגיות</button>
      </div>
    </div>
  );
}

function SortableHeader({ label, columnKey, sortConfig, onSort, align = "right" }) {
  const isActive = sortConfig.key === columnKey;
  const indicator = isActive ? (sortConfig.direction === "asc" ? " " : " ") : "";
  const alignClass = align === "left" ? "text-left" : "text-right";
  return (
    <th className={`sticky top-0 z-20 bg-slate-50 p-3 shadow-[0_1px_0_0_rgba(226,232,240,1)] ${alignClass}`}>
      <button type="button" className="font-semibold hover:text-slate-900" onClick={() => onSort(columnKey)} aria-label={`מיון לפי ${label}`}>
        {label}{indicator}
      </button>
    </th>
  );
}

function FiltersPanel({ filters, rangeOption, sources, categories, tags, collapsed, onToggleCollapsed, onFilter, onRange, onManualDate }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <button type="button" className="font-semibold text-slate-950 hover:text-slate-700" onClick={onToggleCollapsed} aria-expanded={!collapsed}>חיפוש וסינון</button>
      {!collapsed && (
        <div className="mt-3 space-y-3">
          <Field label="חיפוש">
            <input className="input w-full" value={filters.q} onChange={(event) => onFilter({ q: event.target.value })} placeholder="תיאור, בית עסק, סכום" />
          </Field>
          <Field label="טווח תאריכים">
            <select className="select w-full" value={rangeOption} onChange={(event) => onRange(event.target.value)}>
              <option value="custom">טווח מותאם אישית</option>
              {TRANSACTIONS_RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
          {rangeOption === "custom" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="מתאריך">
                <DateRangeTextInput value={filters.from} onChange={(value) => onManualDate({ from: value })} />
              </Field>
              <Field label="עד תאריך">
                <DateRangeTextInput value={filters.to} onChange={(value) => onManualDate({ to: value })} />
              </Field>
            </div>
          )}
          <Field label="מקור">
            <select className="select w-full" value={filters.source} onChange={(event) => onFilter({ source: event.target.value })}>
              <option value="">כל המקורות</option>
              {sources.map((source) => <option key={source} value={source}>{formatSourceLabel(source)}</option>)}
            </select>
          </Field>
          <Field label="סוג">
            <select className="select w-full" value={filters.direction} onChange={(event) => onFilter({ direction: event.target.value })}>
              <option value="">הכנסות והוצאות</option>
              <option value="expense">הוצאות</option>
              <option value="income">הכנסות</option>
            </select>
          </Field>
          <Field label="קטגוריה">
            <select className="select w-full" value={filters.uncategorized === "1" ? "uncategorized" : filters.categoryId} onChange={(event) => {
              const value = event.target.value;
              onFilter(value === "uncategorized" ? { categoryId: "", uncategorized: "1" } : { categoryId: value, uncategorized: "0" });
            }}>
              <option value="">כל הקטגוריות</option>
              <option value="uncategorized">לא מסווג</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.icon ? `${category.icon} ` : ""}{category.name_he}</option>)}
            </select>
          </Field>
          <Field label="תגיות">
            <TagToggleList
                tags={tags}
              selectedTagIds={filters.tagIds}
              onToggle={(tagId) => {
                const next = new Set(filters.tagIds.map(Number));
                if (next.has(tagId)) {
                  next.delete(tagId);
                } else {
                  next.add(tagId);
                }
                onFilter({ tagIds: Array.from(next).map(String), untagged: "0" });
              }}
              />
          </Field>
          <div className="flex flex-wrap gap-2 pt-1">
            <button className="btn" onClick={() => { onRange("custom"); onFilter({ from: isoMonthStart(), to: isoToday(), q: "", source: "", categoryId: "", direction: "", tagIds: [], untagged: "0", uncategorized: "0" }); }}>נקה</button>
            <button className="btn" disabled title="יבוצע בשלב הדוחות">צור דוח מהסינון</button>
          </div>
        </div>
      )}
    </div>
  );
}
function SelectedTransactionPanel({ transaction, categories, tags, tagIds, tagNames, selectedCount, collapsed, onToggleCollapsed, onCategoryChange, onTagsChange, onMoreDetails, onBulkCategoryChange, onBulkTagAdd, onBulkTagRemove, onBulkTagsClear }) {
  if (selectedCount > 0) {
    return (
      <div className={(collapsed ? "" : "min-h-[300px] ") + "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"}>
        <button type="button" className="font-semibold text-slate-950 hover:text-slate-700" onClick={onToggleCollapsed} aria-expanded={!collapsed}>פעולות על תנועות שנבחרו</button>
        {!collapsed && (
          <>
            <div className="mt-1 text-sm text-slate-500">נבחרו {selectedCount} תנועות. הפעולות כאן יחולו על כולן.</div>
            <BulkActions categories={categories} tags={tags} onCategory={onBulkCategoryChange} onTag={onBulkTagAdd} onRemoveTag={onBulkTagRemove} onClearTags={onBulkTagsClear} />
          </>
        )}
      </div>
    );
  }

  if (!transaction) {
    return (
      <div className={(collapsed ? "" : "min-h-[300px] ") + "rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm"}>
        <button type="button" className="font-semibold text-slate-950 hover:text-slate-700" onClick={onToggleCollapsed} aria-expanded={!collapsed}>פרטי תנועה</button>
        {!collapsed && <div className="mt-2">בחר תנועה כדי לראות פרטים.</div>}
      </div>
    );
  }

  const installmentDetails = getInstallmentDetails(transaction);
  const amountTone = Number(transaction.amount_signed || 0) < 0 ? "negative" : "positive";
  const descriptionLabels = getTransactionDescriptionLabels(transaction);

  return (
    <div className={(collapsed ? "" : "min-h-[300px] ") + "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"}>
      <div className="flex items-center justify-between gap-3">
        <button type="button" className="font-semibold text-slate-950 hover:text-slate-700" onClick={onToggleCollapsed} aria-expanded={!collapsed}>פרטי תנועה</button>
        <button type="button" className="btn justify-center" onClick={onMoreDetails}>פרטים נוספים</button>
      </div>
      {!collapsed && (
        <>
          <div className="mt-1 space-y-1 text-sm text-slate-500">
            <div className="break-words">{descriptionLabels.title}</div>
            {descriptionLabels.secondary && <div className="break-words text-xs">{descriptionLabels.secondary}</div>}
          </div>
          <div className="mt-4 space-y-3 text-sm">
            <CompactTransactionFacts date={formatDateDMY(transaction.txn_date)} amount={formatILS(transaction.amount_signed)} amountTone={amountTone} />
            {transaction.notes && <Detail label="הערות" value={transaction.notes} />}
            {installmentDetails?.label && <Detail label="תשלומים" value={installmentDetails.label} />}
            {installmentDetails?.totalAmount != null && <Detail label="סכום עסקה כולל" value={formatILS(installmentDetails.totalAmount)} tone={amountTone} />}
            <Detail label="מקור" value={formatSourceLabel(transaction.source || "", { cardLast4: transaction.account_ref })} />
          </div>
        </>
      )}
    </div>
  );
}
function TagToggleList({ tags, selectedTagIds, onToggle }) {
  const selected = new Set(selectedTagIds.map(Number));

  return (
    <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-xl border border-slate-300 bg-white p-2">
      {tags.map((tag) => {
        const isSelected = selected.has(tag.id);

        return (
          <button
            key={tag.id}
            type="button"
            className={(isSelected ? "border-slate-900 bg-slate-900 text-white " : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 ") + "rounded-full border px-3 py-1 text-xs"}
            onClick={() => onToggle(tag.id)}
            aria-pressed={isSelected}
          >
            {tag.icon ? `${tag.icon} ` : ""}{tag.name_he}
          </button>
        );
      })}
      {tags.length === 0 && <div className="text-xs text-slate-500">אין תגיות</div>}
    </div>
  );
}

function getTransactionDescriptionLabels(transaction) {
  const baseLabel = transaction?.merchant || transaction?.description || "-";
  const installmentLabel = getInstallmentDetails(transaction)?.label;
  const title = installmentLabel && installmentLabel !== "עסקת תשלומים" && baseLabel !== "-" ? `${baseLabel} (${installmentLabel})` : baseLabel;
  const secondary = transaction?.category_raw || (transaction?.description && transaction.description !== baseLabel ? transaction.description : "");
  const tooltip = [title, secondary].filter(Boolean).join("\n");

  return { title, secondary, tooltip };
}
function TransactionTagsCell({ tags, editable, onEdit }) {
  const label = tags.length ? tags.map((tag) => tag.name_he).join(", ") : "אין";

  return (
    <td
      className={(editable ? "cursor-pointer " : "") + "relative w-32 max-w-32 p-3 text-slate-600"}
      onClick={(event) => {
        if (!editable) return;
        event.stopPropagation();
        onEdit();
      }}
    >
      <div className="group relative w-32 max-w-full">
        <div className="truncate" aria-label={label}>{label}</div>
        {tags.length > 0 && (
          <div className="pointer-events-none absolute right-0 top-full z-40 mt-2 hidden w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-lg group-hover:block">
            <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
              {tags.map((tag) => (
                <span key={tag.id} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
                  {tag.icon ? `${tag.icon} ` : ""}{tag.name_he}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </td>
  );
}

function DateRangeTextInput({ value, onChange }) {
  const [draft, setDraft] = useState(formatDateDMY(value) || "");

  useEffect(() => {
    setDraft(formatDateDMY(value) || "");
  }, [value]);

  function handleChange(event) {
    const nextDraft = event.target.value;
    setDraft(nextDraft);
    if (!nextDraft.trim()) {
      onChange("");
      return;
    }
    const parsed = parseDateDMY(nextDraft);
    if (parsed) {
      onChange(parsed);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        className="input min-w-0 flex-1"
        dir="ltr"
        inputMode="numeric"
        placeholder="DD/MM/YYYY"
        value={draft}
        onChange={handleChange}
        onBlur={() => setDraft(formatDateDMY(value) || "")}
      />
      <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-slate-300 bg-white text-slate-500">
        <span aria-hidden="true">📅</span>
        <input
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          type="date"
          value={value || ""}
          onChange={(event) => onChange(event.target.value)}
          aria-label="פתח בחירת תאריך"
          title="פתח בחירת תאריך"
        />
      </span>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <label className="block text-xs text-slate-500">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

function CompactTransactionFacts({ date, amount, amountTone }) {
  const amountColor = amountTone === "positive" ? "text-emerald-600" : amountTone === "negative" ? "text-red-600" : "text-slate-900";
  return (
    <div className="grid grid-cols-2 gap-3 border-b border-slate-100 pb-2">
      <div>
        <div className="text-xs text-slate-500">תאריך</div>
        <div className="mt-1 font-semibold text-slate-900">{date}</div>
      </div>
      <div className="text-left">
        <div className="text-xs text-slate-500">סכום חיוב</div>
        <div className={`${amountColor} mt-1 font-semibold`} dir="ltr">{amount}</div>
      </div>
    </div>
  );
}
function Detail({ label, value, tone = "neutral" }) {
  const color = tone === "positive" ? "text-emerald-600" : tone === "negative" ? "text-red-600" : "text-slate-900";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2">
      <span className="text-slate-500">{label}</span>
      <span className={`${color} text-left font-semibold`} dir="ltr">{value}</span>
    </div>
  );
}

function getInstallmentDetails(transaction) {
  if (!String(transaction?.source || "").startsWith("כ.אשראי")) return null;
  const raw = parseRawDetails(transaction.raw_json);
  const typeRaw = getRawValue(raw, /סוג\s*עסקה/) || "";
  if (!String(typeRaw).includes("תשלומים")) return null;
  const currentValue = getRawValue(raw, /מספר\s*תשלום|מס['׳]?\s*תשלום|תשלום\s*מספר/);
  const totalValue = getRawValue(raw, /מספר\s*תשלומים|מס['׳]?\s*תשלומים|סך\s*תשלומים|סה["׳']?כ\s*תשלומים/);
  const pair = parseInstallmentPair(typeRaw) || parseInstallmentPair(currentValue) || parseInstallmentPair(totalValue) || findInstallmentPairInRaw(raw);
  const currentNumber = parseInstallmentNumber(currentValue);
  const totalNumber = parseInstallmentNumber(totalValue);
  const label = pair ? `${pair.current}/${pair.total}` : currentNumber && totalNumber ? `${currentNumber}/${totalNumber}` : null;

  return {
    label: label || "עסקת תשלומים",
    totalAmount: transaction.original_amount_signed,
  };
}

function parseRawDetails(rawJson) {
  if (!rawJson) return {};
  if (typeof rawJson === "object") return rawJson;
  try {
    return JSON.parse(rawJson);
  } catch {
    return {};
  }
}

function getRawValue(raw, matcher) {
  if (!raw || typeof raw !== "object") return null;
  const key = Object.keys(raw).find((entry) => matcher.test(entry));
  return key ? raw[key] : null;
}

function parseInstallmentPair(value) {
  if (value == null || value === "") return null;
  const match = String(value).trim().match(/(\d+)\s*(?:\/|מתוך)\s*(\d+)/);
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(current) || !Number.isInteger(total) || total <= 0) return null;
  return { current, total };
}

function parseInstallmentNumber(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  const direct = Number(text);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const pair = parseInstallmentPair(text);
  return pair ? pair.current : null;
}
function findInstallmentPairInRaw(raw) {
  if (!raw || typeof raw !== "object") return null;
  for (const value of Object.values(raw)) {
    const pair = parseInstallmentPair(value);
    if (pair) return pair;
  }
  return null;
}
function resolveForecastLabel(transaction, names) {
  const text = names.join(" ");
  if (/לא לחישוב|מוחרג|העברה|כרטיס/.test(text)) return "מוחרג";
  if (/תשלומים|הלוואה|חודשי|קבוע|משכורת|שכר/.test(text)) return "נכלל";
  if (!transaction.category_id) return "דורש סיווג";
  return "לא חוזה";
}

function BalanceTimeline({ rows, selectedId, forecastValue, onPointClick }) {
  const transactionPoints = rows
    .filter((row) => row.balance_amount != null)
    .map((row) => ({
      id: row.id,
      date: row.txn_date,
      value: Number(row.balance_amount || 0),
      kind: "actual",
    }));
  const forecastNumber = Number(forecastValue || 0);
  const chartPoints = transactionPoints.concat([{ id: "forecast", date: null, value: forecastNumber, kind: "forecast" }]);
  const totalPoints = chartPoints.length;
  const [view, setView] = useState({ start: Math.max(0, totalPoints - Math.min(36, totalPoints)), count: Math.min(36, totalPoints) });
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const dragRef = useRef(null);
  const svgRef = useRef(null);

  useEffect(() => {
    const count = Math.min(36, Math.max(1, totalPoints));
    setView({ start: Math.max(0, totalPoints - count), count });
    setHoveredIndex(null);
  }, [totalPoints]);

  const chartWidth = 760;
  const chartHeight = 230;
  const plotLeft = 136;
  const plotRight = 746;
  const plotTop = 24;
  const plotBottom = 188;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const visibleCount = Math.min(Math.max(1, view.count), totalPoints);
  const visibleStart = clampNumber(view.start, 0, Math.max(0, totalPoints - visibleCount));
  const visiblePoints = chartPoints.slice(visibleStart, visibleStart + visibleCount);
  const visibleValues = visiblePoints.map((point) => point.value);
  const rawMin = Math.min(...visibleValues, 0);
  const rawMax = Math.max(...visibleValues, 1);
  const valuePadding = Math.max(1, (rawMax - rawMin) * 0.08);
  const min = rawMin - valuePadding;
  const max = rawMax + valuePadding;
  const y = (value) => plotBottom - ((value - min) / Math.max(1, max - min)) * plotHeight;
  const x = (index) => visiblePoints.length > 1 ? plotLeft + (index / (visiblePoints.length - 1)) * plotWidth : plotLeft + plotWidth / 2;
  const yTicks = Array.from({ length: 5 }, (_, index) => min + ((max - min) / 4) * index).reverse();
  const xTickStep = Math.max(1, Math.ceil(visiblePoints.length / 9));
  const labelStep = Math.max(1, Math.ceil(visiblePoints.length / 10));
  const selectedVisibleIndex = visiblePoints.findIndex((point) => isSameTransactionId(point.id, selectedId));
  const activeIndex = hoveredIndex ?? (selectedVisibleIndex >= 0 ? selectedVisibleIndex : null);
  const activePoint = activeIndex != null ? visiblePoints[activeIndex] : null;
  const activeDateLabel = activePoint ? activePoint.kind === "forecast" ? "תחזית" : formatDateDMY(activePoint.date) : "";
  const activeDateLabelWidth = getChartPillWidth(activeDateLabel);
  const activePointX = activeIndex != null ? x(activeIndex) : 0;
  const activePointY = activePoint ? y(activePoint.value) : 0;
  const activeValueLabel = activePoint ? formatChartMoney(activePoint.value) : "";
  const activeValueLabelY = activePoint ? Math.max(14, activePointY - 12) : 0;
  const activeValueLabelWidth = getChartPillWidth(activeValueLabel);

  function handleWheel(event) {
    if (totalPoints <= 1) return;
    event.preventDefault();
    event.stopPropagation();
    const minimumCount = Math.min(8, totalPoints);
    const step = event.deltaY > 0 ? 4 : -4;
    const target = event.currentTarget || svgRef.current;
    const rect = target.getBoundingClientRect();
    const ratio = clampNumber((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);

    setView((current) => {
      const currentCount = Math.min(Math.max(1, current.count), totalPoints);
      const nextCount = clampNumber(currentCount + step, minimumCount, totalPoints);
      const focusIndex = current.start + ratio * Math.max(1, currentCount - 1);
      const nextStart = clampNumber(Math.round(focusIndex - ratio * Math.max(1, nextCount - 1)), 0, Math.max(0, totalPoints - nextCount));
      return { start: nextStart, count: nextCount };
    });
  }

  useEffect(() => {
    const element = svgRef.current;
    if (!element) return undefined;
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [totalPoints]);

  function handlePointerDown(event) {
    if (totalPoints <= visibleCount || event.target.closest?.("[data-chart-point-id]")) return;
    dragRef.current = { x: event.clientX, start: visibleStart, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    if (!dragRef.current) return;
    const stepPixels = plotWidth / Math.max(1, visibleCount - 1);
    const deltaPoints = Math.round((dragRef.current.x - event.clientX) / Math.max(1, stepPixels));
    setView((current) => ({
      ...current,
      start: clampNumber(dragRef.current.start + deltaPoints, 0, Math.max(0, totalPoints - current.count)),
    }));
  }

  function handlePointerUp(event) {
    const pointerId = dragRef.current?.pointerId;
    dragRef.current = null;
    if (pointerId == null || !event.currentTarget.hasPointerCapture?.(pointerId)) return;
    event.currentTarget.releasePointerCapture(pointerId);
  }

  return (
    <svg
      ref={svgRef}
      className="h-64 w-full cursor-grab select-none active:cursor-grabbing"
      viewBox={`0 0 ${chartWidth} ${chartHeight}`}
      preserveAspectRatio="xMinYMid meet"
      role="img"
      aria-label="יתרה לאורך התנועות"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={(event) => { setHoveredIndex(null); handlePointerUp(event); }}
    >
      <rect x="0" y="0" width={chartWidth} height={chartHeight} fill="white" />
      {yTicks.map((tick) => {
        const tickY = y(tick);
        return (
          <g key={tick}>
            <line x1={plotLeft} y1={tickY} x2={plotRight} y2={tickY} stroke="#e2e8f0" />
            <text x="44" y={tickY + 4} fill="#64748b" fontSize="11" direction="ltr" unicodeBidi="bidi-override">{formatChartMoney(tick)}</text>
          </g>
        );
      })}
      <line x1={plotLeft} y1={plotBottom} x2={plotRight} y2={plotBottom} stroke="#cbd5e1" />
      <line x1={plotLeft} y1={plotTop} x2={plotLeft} y2={plotBottom} stroke="#cbd5e1" />
      {visiblePoints.map((point, index) => {
        if (index % xTickStep !== 0 && index !== visiblePoints.length - 1) return null;
        return (
          <text key={`${point.id}-x`} x={x(index)} y="212" textAnchor="middle" fill="#64748b" fontSize="11">
            {point.kind === "forecast" ? "תחזית" : formatChartDate(point.date)}
          </text>
        );
      })}
      {visiblePoints.slice(1).map((point, index) => {
        const previous = visiblePoints[index];
        const isForecastSegment = point.kind === "forecast" || previous.kind === "forecast";
        return (
          <line
            key={`${previous.id}-${point.id}`}
            x1={x(index)}
            y1={y(previous.value)}
            x2={x(index + 1)}
            y2={y(point.value)}
            stroke={isForecastSegment ? "#7c3aed" : "#2563eb"}
            strokeDasharray={isForecastSegment ? "8 6" : undefined}
            strokeWidth="2"
          />
        );
      })}
      {activePoint && (
        <g pointerEvents="none">
          <line x1={x(activeIndex)} y1={y(activePoint.value)} x2={x(activeIndex)} y2={plotBottom} stroke="#93c5fd" strokeWidth="1.5" />
          <circle cx={x(activeIndex)} cy={y(activePoint.value)} r="8" fill="white" stroke="#2563eb" strokeWidth="3" />
          <rect x={x(activeIndex) - activeDateLabelWidth / 2} y={plotBottom + 6} width={activeDateLabelWidth} height="20" rx="10" fill="white" stroke="#bfdbfe" />
          <text x={x(activeIndex)} y={plotBottom + 20} textAnchor="middle" fill="#2563eb" fontSize="11" fontWeight="700">
            {activeDateLabel}
          </text>
        </g>
      )}
      {visiblePoints.map((point, index) => {
        const pointX = x(index);
        const pointY = y(point.value);
        const isActive = index === activeIndex;
        const shouldLabel = point.kind === "forecast" || visiblePoints.length <= 16 || index % labelStep === 0;
        const valueLabel = formatChartMoney(point.value);
        const valueLabelY = Math.max(14, pointY - 12);
        return (
          <g key={point.id} data-chart-point-id={point.kind === "actual" ? point.id : undefined} onMouseEnter={() => setHoveredIndex(index)} onClick={(event) => { if (point.kind !== "actual") return; event.stopPropagation(); onPointClick?.(point.id); }} style={{ cursor: point.kind === "actual" ? "pointer" : "default" }}>
            {shouldLabel && (
              <>
                <text x={pointX} y={valueLabelY} textAnchor="middle" fill={isActive ? "#2563eb" : "#64748b"} fontSize="11" fontWeight={isActive ? "700" : "500"} direction="ltr" unicodeBidi="bidi-override">
                  {valueLabel}
                </text>
              </>
            )}
            {point.kind === "actual" && <circle cx={pointX} cy={pointY} r="12" fill="transparent" />}
            <circle cx={pointX} cy={pointY} r={isActive ? 5 : 3.5} fill={point.kind === "forecast" ? "#7c3aed" : "#2563eb"} stroke="white" strokeWidth="2" />
          </g>
        );
      })}
      {activePoint && (
        <g pointerEvents="none">
          <rect x={activePointX - activeValueLabelWidth / 2} y={activeValueLabelY - 14} width={activeValueLabelWidth} height="20" rx="10" fill="white" stroke="#bfdbfe" />
          <text x={activePointX} y={activeValueLabelY} textAnchor="middle" fill="#2563eb" fontSize="11" fontWeight="700" direction="ltr" unicodeBidi="bidi-override">
            {activeValueLabel}
          </text>
        </g>
      )}
    </svg>
  );
}

function isSameTransactionId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getChartPillWidth(label) {
  return Math.max(42, String(label || "").length * 7 + 16);
}

function formatChartMoney(value) {
  const amount = Math.round(Number(value || 0));
  const sign = amount < 0 ? "-" : "";
  return `\u200e${sign}${Math.abs(amount).toLocaleString("he-IL")} ₪`;
}

function formatChartDate(dateValue) {
  const formatted = formatDateDMY(dateValue);
  if (!formatted) return "";
  const [day, month] = formatted.split("/");
  return day && month ? `${day}/${month}` : formatted;
}

function buildCsv(rows, tags, categories) {
  const tagLookup = new Map(tags.map((tag) => [tag.id, tag.name_he]));
  const categoryLookup = new Map(categories.map((category) => [category.id, category.name_he]));
  const headers = ["מספר", "תאריך", "סכום", "תיאור", "יתרה", "תגים", "קטגוריה", "מקור"];
  const lines = [headers.map(escapeCsvValue).join(",")];
  rows.forEach((row) => {
    const tagNames = parseCsvTagIds(row.tags).map((id) => tagLookup.get(id)).filter(Boolean).join(", ");
    const categoryName = row.category_name || (row.category_id ? categoryLookup.get(row.category_id) : null) || "";
    const csvRow = [
      row.chronological_index ?? "",
      row.txn_date || row.posting_date || "",
      row.amount_signed ?? "",
      row.description || row.merchant || "",
      row.balance_amount ?? "",
      tagNames,
      categoryName,
      formatSourceLabel(row.source || ""),
    ];
    lines.push(csvRow.map(escapeCsvValue).join(","));
  });
  return `\uFEFF${lines.join("\n")}`;
}

function parseCsvTagIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(Number).filter((item) => !Number.isNaN(item));
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(Number).filter((item) => !Number.isNaN(item));
  } catch {
    // Keep supporting comma-separated legacy values.
  }
  return String(value).split(",").map((item) => Number(item.trim())).filter((item) => !Number.isNaN(item));
}

function escapeCsvValue(value) {
  if (value == null) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}
