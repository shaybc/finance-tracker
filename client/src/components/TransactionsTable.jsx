import React, { useState, useEffect, useRef } from "react";
import { formatILS } from "../utils/format.js";
import { formatSourceLabel } from "../utils/source.js";
import { apiPost } from "../api.js";
import toast from "react-hot-toast";

export default function TransactionsTable({
  rows,
  categories,
  tags = [],
  onUpdateCategory,
  onUpdateTags,
  sortConfig,
  onSortChange,
  onFilterByDescription,
  onFilterByDirection,
  onFilterByMonth,
}) {
  const [contextMenu, setContextMenu] = useState(null);
  const [categorySubmenu, setCategorySubmenu] = useState(null);
  const [isCreatingRule, setIsCreatingRule] = useState(false);
  const [tagEditor, setTagEditor] = useState(null);
  const [tagSelection, setTagSelection] = useState(new Set());
  const [detailsTransaction, setDetailsTransaction] = useState(null);
  const [isHeaderFloating, setIsHeaderFloating] = useState(false);
  const [floatingHeader, setFloatingHeader] = useState({
    left: 0,
    width: 0,
    height: 0,
    colWidths: [],
  });
  const [scrollLeft, setScrollLeft] = useState(0);
  const menuRef = useRef(null);
  const tagEditorRef = useRef(null);
  const tableRef = useRef(null);
  const headerRef = useRef(null);
  const scrollContainerRef = useRef(null);

  function formatTransactionDate(dateValue) {
    if (!dateValue) {
      return "—";
    }

    if (typeof dateValue === "string") {
      const [year, month, day] = dateValue.split("-");
      if (year && month && day) {
        return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
      }
    }

    const parsed = new Date(dateValue);
    if (Number.isNaN(parsed.getTime())) {
      return dateValue;
    }

    const day = String(parsed.getDate()).padStart(2, "0");
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const year = parsed.getFullYear();
    return `${day}/${month}/${year}`;
  }

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setContextMenu(null);
        setCategorySubmenu(null);
      }
    }

    if (contextMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [contextMenu]);

  useEffect(() => {
    function handleTagEditorClick(event) {
      if (tagEditorRef.current && !tagEditorRef.current.contains(event.target)) {
        setTagEditor(null);
      }
    }

    if (tagEditor) {
      document.addEventListener("mousedown", handleTagEditorClick);
      return () => document.removeEventListener("mousedown", handleTagEditorClick);
    }
  }, [tagEditor]);

  useEffect(() => {
    let frame;

    function updateFloatingHeader() {
      if (!tableRef.current || !headerRef.current) {
        return;
      }

      const tableRect = tableRef.current.getBoundingClientRect();
      const headerRect = headerRef.current.getBoundingClientRect();
      const shouldFloat = tableRect.top < 0 && tableRect.bottom > headerRect.height;

      setIsHeaderFloating(shouldFloat);

      if (!shouldFloat) {
        return;
      }

      const colWidths = Array.from(headerRef.current.querySelectorAll("th")).map((cell) =>
        cell.getBoundingClientRect().width
      );

      setFloatingHeader({
        left: tableRect.left,
        width: tableRect.width,
        height: headerRect.height,
        colWidths,
      });
    }

    function handleScrollOrResize() {
      if (frame) {
        return;
      }

      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateFloatingHeader();
      });
    }

    handleScrollOrResize();
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);

    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [rows, sortConfig]);

  // Close menu on scroll (but not if scrolling inside the submenu)
  useEffect(() => {
    function handleScroll(e) {
      // Don't close if scrolling inside the submenu
      if (menuRef.current && menuRef.current.contains(e.target)) {
        return;
      }
      setContextMenu(null);
      setCategorySubmenu(null);
    }

    if (contextMenu) {
      window.addEventListener("scroll", handleScroll, true);
      return () => window.removeEventListener("scroll", handleScroll, true);
    }
  }, [contextMenu]);

  function handleContextMenu(e, row) {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      row: row,
    });
    setCategorySubmenu(null);
  }

  function handleFilterByDescription(transaction) {
    const description = transaction.merchant || transaction.description || "";
    if (description) {
      onFilterByDescription(description);
      setContextMenu(null);
      setCategorySubmenu(null);
      toast.success(`מסנן לפי: "${description}"`);
    } else {
      toast.error("אין תיאור לסינון");
    }
  }

  function handleFilterByCategory(transaction) {
    if (transaction.category_id) {
      const category = categories.find(c => c.id === transaction.category_id);
      onFilterByDescription(null, transaction.category_id);
      setContextMenu(null);
      setCategorySubmenu(null);
      toast.success(`מסנן לפי קטגוריה: "${category?.name_he || transaction.category_id}"`);
    } else {
      toast.error("אין קטגוריה לתנועה זו");
    }
  }

  function handleFilterByDirection(direction) {
    onFilterByDirection(direction);
    setContextMenu(null);
    setCategorySubmenu(null);
    const label = direction === "expense" ? "הוצאות" : "הכנסות";
    toast.success(`מסנן רק ${label}`);
  }

  function handleFilterByMonth(transaction) {
    if (!transaction.txn_date) {
      toast.error("אין תאריך לתנועה זו");
      return;
    }

    // Extract year and month from txn_date (format: YYYY-MM-DD)
    const date = new Date(transaction.txn_date);
    const year = date.getFullYear();
    const month = date.getMonth() + 1; // JavaScript months are 0-indexed
    
    // Get first and last day of the month
    const firstDay = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate(); // Day 0 of next month = last day of current month
    const lastDayFormatted = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    
    onFilterByMonth(firstDay, lastDayFormatted);
    setContextMenu(null);
    setCategorySubmenu(null);
    
    const monthNames = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
    toast.success(`מסנן עבור ${monthNames[month - 1]} ${year}`);
  }

  function parseTagIds(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map((item) => Number(item)).filter((item) => !Number.isNaN(item));
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

  function resolveTagNames(tagIds) {
    const lookup = new Map(tags.map((tag) => [tag.id, tag.name_he]));
    return tagIds.map((id) => lookup.get(id)).filter(Boolean);
  }

  function openTagEditor(row, event) {
    event.stopPropagation();
    const tagIds = parseTagIds(row.tags);
    setTagSelection(new Set(tagIds));
    setTagEditor({
      rowId: row.id,
      x: event.clientX,
      y: event.clientY,
    });
  }

  async function toggleTagSelection(rowId, tagId) {
    const next = new Set(tagSelection);
    if (next.has(tagId)) {
      next.delete(tagId);
    } else {
      next.add(tagId);
    }
    setTagSelection(next);
    await onUpdateTags(rowId, Array.from(next));
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

  function findRawValue(raw, matcher) {
    if (!raw || typeof raw !== "object") return null;
    const key = Object.keys(raw).find((entry) => matcher.test(entry));
    if (!key) {
      return null;
    }
    return raw[key];
  }

  function parseInstallmentPair(value) {
    if (value == null || value === "") return null;
    const text = String(value).trim();
    if (!text) return null;
    const match = text.match(/(\d+)\s*(?:\/|מתוך)\s*(\d+)/);
    if (!match) return null;
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isInteger(current) || !Number.isInteger(total) || total <= 0) {
      return null;
    }
    return { current, total };
  }

  function parseInstallmentNumber(value) {
    if (value == null || value === "") return null;
    const text = String(value).trim();
    if (!text) return null;
    const direct = Number(text);
    if (Number.isInteger(direct) && direct > 0) {
      return direct;
    }
    const pair = parseInstallmentPair(text);
    return pair ? pair.current : null;
  }

  function getTypeRaw(raw) {
    if (!raw || typeof raw !== "object") return "";
    const direct = raw["סוג עסקה"] ?? raw["סוגעסקה"];
    if (direct != null) {
      return String(direct).trim();
    }
    const fallbackKey = Object.keys(raw).find((key) => /סוג\s*עסקה/.test(key));
    if (fallbackKey) {
      return String(raw[fallbackKey] ?? "").trim();
    }
    return "";
  }

  function getInstallmentLabel(row) {
    if (!row) return null;
    const raw = parseRawDetails(row.raw_json);
    const typeRaw = getTypeRaw(raw);
    const pairFromType = parseInstallmentPair(typeRaw);
    if (pairFromType) {
      return `${pairFromType.current}/${pairFromType.total}`;
    }

    const currentValue = findRawValue(raw, /מספר\s*תשלום|מס['׳]?\s*תשלום|תשלום\s*מספר/);
    const totalValue = findRawValue(raw, /מספר\s*תשלומים|מס['׳]?\s*תשלומים|סך\s*תשלומים|סה["׳']?כ\s*תשלומים/);

    const pairFromCurrent = parseInstallmentPair(currentValue);
    if (pairFromCurrent) {
      return `${pairFromCurrent.current}/${pairFromCurrent.total}`;
    }

    const pairFromTotal = parseInstallmentPair(totalValue);
    if (pairFromTotal) {
      return `${pairFromTotal.current}/${pairFromTotal.total}`;
    }

    const currentNumber = parseInstallmentNumber(currentValue);
    const totalNumber = parseInstallmentNumber(totalValue);
    if (currentNumber && totalNumber) {
      return `${currentNumber}/${totalNumber}`;
    }

    if (typeRaw.includes("תשלומים")) {
      return null;
    }

    return null;
  }

  function getDetailItems(row) {
    if (!row) return [];
    const tagIds = parseTagIds(row.tags);
    const tagNames = resolveTagNames(tagIds);
    const baseItems = [
      ["מקור", sourceLabel(row.source, row.account_ref)],
      ["חשבון/כרטיס", row.account_ref || "—"],
      ["תאריך עסקה", formatTransactionDate(row.txn_date)],
      ["תאריך ערך", row.posting_date ? formatTransactionDate(row.posting_date) : "—"],
      ["בית עסק", row.merchant || "—"],
      ["תיאור", row.description || "—"],
      ["תיאור חברת האשראי", row.category_raw || "—"],
      ["סכום", formatILS(row.amount_signed)],
      ["מטבע", row.currency || "—"],
      ["כיוון", row.direction === "income" ? "הכנסה" : row.direction === "expense" ? "הוצאה" : "—"],
      ["קטגוריה", row.category_name || "לא מסווג"],
      ["תגיות", tagNames.length ? tagNames.join(", ") : "אין"],
      ["שורת מקור", row.source_row || "—"],
      ["קובץ מקור", row.source_file || "—"],
    ];
    if (row.original_txn_date) {
      baseItems.splice(3, 0, ["תאריך עסקה מקורי", formatTransactionDate(row.original_txn_date)]);
    }
    if (row.original_amount_signed != null) {
      const amountIndex = baseItems.findIndex((item) => item[0] === "סכום");
      const insertIndex = amountIndex >= 0 ? amountIndex + 1 : baseItems.length;
      baseItems.splice(insertIndex, 0, ["סכום עסקה מקורי", formatILS(row.original_amount_signed)]);
    }

    const raw = parseRawDetails(row.raw_json);
    const rawEntries = Object.entries(raw).map(([key, value]) => [
      key,
      value === "" || value == null ? "—" : String(value),
    ]);

    return { baseItems, rawEntries };
  }

  function handleRowClick(row, event) {
    if (event.defaultPrevented) {
      return;
    }
    setDetailsTransaction(row);
  }

  function getRulePattern(transaction, matchField) {
    if (matchField === "category_raw") {
      return transaction.category_raw || "";
    }
    return transaction.merchant || transaction.description || "";
  }

  async function createRuleFromTransaction(transaction, categoryId, matchField) {
    setIsCreatingRule(true);
    
    try {
      const pattern = getRulePattern(transaction, matchField);
      
      if (!pattern) {
        toast.error(
          matchField === "category_raw"
            ? "לא ניתן לקבוע חוק - אין תיאור מחברת האשראי"
            : "לא ניתן לקבוע חוק - אין תיאור או בית עסק"
        );
        setIsCreatingRule(false);
        return;
      }

      const category = categories.find(c => c.id === categoryId);
      const ruleName = `${pattern} → ${category?.name_he || 'קטגוריה'}`;

      await apiPost("/api/rules", {
        name: ruleName,
        match_field: matchField,
        match_type: "contains",
        pattern: pattern,
        source: transaction.source || null,
        direction: transaction.direction || null,
        category_id: categoryId,
      });

      toast.success(`חוק נוצר: "${pattern}" → ${category?.name_he}`);
      setContextMenu(null);
      setCategorySubmenu(null);

      // Trigger reload of rules
      window.dispatchEvent(new CustomEvent('reload-rules'));
    } catch (err) {
      console.error("Failed to create rule:", err);
      toast.error("שגיאה ביצירת החוק");
    } finally {
      setIsCreatingRule(false);
    }
  }

  function renderSortIndicator(key) {
    if (!sortConfig || sortConfig.key !== key) {
      return null;
    }
    return (
      <span className="text-xs text-slate-400" aria-hidden="true">
        {sortConfig.direction === "asc" ? "▲" : "▼"}
      </span>
    );
  }

  function renderSortableHeader(label, key) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 text-slate-700 hover:text-slate-900"
        onClick={() => onSortChange?.(key)}
      >
        <span>{label}</span>
        {renderSortIndicator(key)}
      </button>
    );
  }

  return (
    <>
      <div className="card">
        <div
          className="overflow-x-auto"
          ref={scrollContainerRef}
          onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        >
          <table className="table" ref={tableRef}>
            <thead className="bg-slate-100" ref={headerRef}>
              <tr className="text-right">
                <th className="p-3 bg-slate-100">{renderSortableHeader("תאריך", "txn_date")}</th>
                <th className="p-3 bg-slate-100">{renderSortableHeader("סכום", "amount")}</th>
                <th className="p-3 bg-slate-100">{renderSortableHeader("תיאור/בית עסק", "description")}</th>
                <th className="p-3 bg-slate-100">{renderSortableHeader("תגים", "tags")}</th>
                <th className="p-3 bg-slate-100">{renderSortableHeader("קטגוריה", "category")}</th>
                <th className="p-3 bg-slate-100">{renderSortableHeader("מקור", "source")}</th>
              </tr>
            </thead>
            <tbody>
            {rows.map((r) => (
              <tr 
                key={r.id} 
                className="border-t border-slate-200 hover:bg-slate-50 cursor-context-menu"
                onContextMenu={(e) => handleContextMenu(e, r)}
                onClick={(event) => handleRowClick(r, event)}
              >
                <td className="p-3 whitespace-nowrap">{formatTransactionDate(r.txn_date)}</td>
                <td className="p-3 whitespace-nowrap font-semibold text-right" dir="ltr">
                  {formatILS(r.amount_signed)}
                </td>
                <td className="p-3">
                  {(() => {
                    const baseLabel = r.merchant || r.description || "—";
                    const installmentLabel = getInstallmentLabel(r);
                    const displayLabel =
                      installmentLabel && baseLabel !== "—"
                        ? `${baseLabel} (${installmentLabel})`
                        : baseLabel;
                    return <div className="font-medium">{displayLabel}</div>;
                  })()}
                  <div className="text-xs text-slate-500">{r.category_raw || ""}</div>
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    {(() => {
                      const tagIds = parseTagIds(r.tags);
                      const tagNames = resolveTagNames(tagIds);
                      if (tagNames.length === 0) {
                        const tooltipText = "אין תגים";
                        return (
                          <button
                            type="button"
                            className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700"
                            onClick={(event) => openTagEditor(r, event)}
                            title={tooltipText}
                          >
                            אין תגים
                          </button>
                        );
                      }
                      const [firstTag] = tagNames;
                      const tooltipText = tagNames.join(", ");
                      return (
                        <>
                          <button
                            type="button"
                            className="inline-flex items-center rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white"
                            onClick={(event) => openTagEditor(r, event)}
                            title={tooltipText}
                          >
                            {firstTag}
                          </button>
                          {tagNames.length > 1 && (
                            <span className="text-xs text-slate-600" title={tooltipText}>
                              +{tagNames.length - 1}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </td>
                <td className="p-3 whitespace-nowrap">
                  <select
                    className="select"
                    value={r.category_id || ""}
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onChange={(e) => onUpdateCategory(r.id, e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">לא מסווג</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.icon ? `${c.icon} ` : ""}{c.name_he}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-3 whitespace-nowrap text-xs text-slate-600">{sourceLabel(r.source, r.account_ref)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="p-6 text-center text-slate-500" colSpan={6}>אין נתונים להצגה</td>
              </tr>
            )}
            </tbody>
          </table>
        </div>
      </div>

      {isHeaderFloating && (
        <div
          className="fixed top-0 z-30 overflow-hidden bg-slate-100 shadow-sm"
          style={{
            left: floatingHeader.left,
            width: floatingHeader.width,
          }}
        >
          <div style={{ transform: `translateX(${-scrollLeft}px)` }}>
            <table className="table" style={{ width: floatingHeader.width }}>
              <thead>
                <tr className="text-right">
                  {[
                    { label: "תאריך", key: "txn_date" },
                    { label: "סכום", key: "amount" },
                    { label: "תיאור/בית עסק", key: "description" },
                    { label: "תגים", key: "tags" },
                    { label: "קטגוריה", key: "category" },
                    { label: "מקור", key: "source" },
                  ].map((column, index) => (
                    <th
                      key={column.key}
                      className="p-3 bg-slate-100"
                      style={{ width: floatingHeader.colWidths[index] }}
                    >
                      {renderSortableHeader(column.label, column.key)}
                    </th>
                  ))}
                </tr>
              </thead>
            </table>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed bg-white border border-slate-200 rounded-xl shadow-lg py-1 z-50"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            minWidth: "200px",
          }}
        >
          <div
            className="px-4 py-2 hover:bg-slate-100 cursor-pointer"
            onClick={() => handleFilterByDescription(contextMenu.row)}
          >
            סנן עם תיאור דומה
          </div>

          <div
            className="px-4 py-2 hover:bg-slate-100 cursor-pointer"
            onClick={() => handleFilterByCategory(contextMenu.row)}
          >
            סנן עם קטגוריה דומה
          </div>

          <div
            className="px-4 py-2 hover:bg-slate-100 cursor-pointer"
            onClick={() => handleFilterByMonth(contextMenu.row)}
          >
            סנן מאותו החודש
          </div>

          <div className="border-t border-slate-200 my-1" />

          <div
            className="px-4 py-2 hover:bg-slate-100 cursor-pointer"
            onClick={() => handleFilterByDirection("expense")}
          >
            סנן רק הוצאות
          </div>

          <div
            className="px-4 py-2 hover:bg-slate-100 cursor-pointer"
            onClick={() => handleFilterByDirection("income")}
          >
            סנן רק הכנסות
          </div>
          
          <div className="border-t border-slate-200 my-1" />
          
          <div
            className="relative px-4 py-2 hover:bg-slate-100 cursor-pointer flex items-center justify-between"
            onMouseEnter={() => setCategorySubmenu("merchant")}
          >
            <span>צור חוק מתיאור עסק זה</span>
            <span className="text-slate-400">◀</span>
          </div>

          <div
            className="relative px-4 py-2 hover:bg-slate-100 cursor-pointer flex items-center justify-between"
            onMouseEnter={() => setCategorySubmenu("category_raw")}
          >
            <span>צור חוק מתיאור חברת האשראי</span>
            <span className="text-slate-400">◀</span>
          </div>

          {/* Submenu for categories */}
          {categorySubmenu && (
            <div
              className="absolute bg-white border border-slate-200 rounded-xl shadow-lg py-1 max-h-96 overflow-y-auto"
              style={{
                right: "100%",
                top: "0",
                marginRight: "4px",
                minWidth: "200px",
              }}
              onMouseLeave={() => setCategorySubmenu(null)}
            >
              {categories.map((cat) => (
                <div
                  key={cat.id}
                  className="px-4 py-2 hover:bg-slate-100 cursor-pointer"
                  onClick={() => createRuleFromTransaction(contextMenu.row, cat.id, categorySubmenu)}
                >
                  {cat.icon ? `${cat.icon} ` : ""}{cat.name_he}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Loading Overlay */}
      {isCreatingRule && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 flex flex-col items-center gap-3">
            <div className="animate-spin h-8 w-8 border-4 border-slate-900 border-t-transparent rounded-full" />
            <div className="text-slate-900 font-medium">יוצר חוק...</div>
          </div>
        </div>
      )}

      {tagEditor && (
        <div
          ref={tagEditorRef}
          className="fixed z-50 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
          style={{
            left: Math.min(tagEditor.x + 12, window.innerWidth - 280),
            top: Math.min(tagEditor.y + 12, window.innerHeight - 240),
          }}
        >
          <div className="text-xs text-slate-500 mb-2">בחרו תגיות</div>
          <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
            {tags.map((tag) => (
              <label key={tag.id} className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={tagSelection.has(tag.id)}
                  onChange={() => toggleTagSelection(tagEditor.rowId, tag.id)}
                />
                <span>{tag.icon ? `${tag.icon} ` : ""}{tag.name_he}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {detailsTransaction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setDetailsTransaction(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-slate-900">פרטי תנועה</div>
                <div className="text-sm text-slate-500">
                  {detailsTransaction.merchant || detailsTransaction.description || "—"}
                </div>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:bg-slate-100"
                onClick={() => setDetailsTransaction(null)}
              >
                סגור
              </button>
            </div>

            {(() => {
              const { baseItems, rawEntries } = getDetailItems(detailsTransaction);
              return (
                <>
                  <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/40">
                    <dl className="grid divide-y divide-slate-200 text-sm sm:grid-cols-2 sm:divide-y-0 sm:divide-x sm:divide-x-reverse lg:grid-cols-3">
                      {baseItems.map(([label, value]) => (
                        <div key={label} className="flex items-start justify-between gap-3 px-4 py-3">
                          <dt className="text-xs font-medium text-slate-500">{label}</dt>
                          <dd className="text-sm font-semibold text-slate-900 break-words">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>

                  {rawEntries.length > 0 && (
                    <div className="mt-5">
                      <div className="mb-2 text-sm font-semibold text-slate-800">נתונים מהאקסל</div>
                      <div className="rounded-xl border border-slate-200 bg-white">
                        <dl className="divide-y divide-slate-200 text-sm">
                          {rawEntries.map(([key, value]) => (
                            <div key={key} className="flex items-start justify-between gap-3 px-4 py-3">
                              <dt className="text-xs font-medium text-slate-500">{key}</dt>
                              <dd className="text-sm text-slate-900 break-words">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}
    </>
  );
}

function sourceLabel(source, accountRef) {
  return formatSourceLabel(source, { cardLast4: accountRef });
}
