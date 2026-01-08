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
  const menuRef = useRef(null);
  const tagEditorRef = useRef(null);

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
      <div className="card overflow-hidden">
        <table className="table">
          <thead className="bg-slate-100">
            <tr className="text-right">
              <th className="p-3 sticky top-0 z-10 bg-slate-100">{renderSortableHeader("תאריך", "txn_date")}</th>
              <th className="p-3 sticky top-0 z-10 bg-slate-100">{renderSortableHeader("סכום", "amount")}</th>
              <th className="p-3 sticky top-0 z-10 bg-slate-100">{renderSortableHeader("תיאור/בית עסק", "description")}</th>
              <th className="p-3 sticky top-0 z-10 bg-slate-100">{renderSortableHeader("תגים", "tags")}</th>
              <th className="p-3 sticky top-0 z-10 bg-slate-100">{renderSortableHeader("קטגוריה", "category")}</th>
              <th className="p-3 sticky top-0 z-10 bg-slate-100">{renderSortableHeader("מקור", "source")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr 
                key={r.id} 
                className="border-t border-slate-200 hover:bg-slate-50 cursor-context-menu"
                onContextMenu={(e) => handleContextMenu(e, r)}
              >
                <td className="p-3 whitespace-nowrap">{formatTransactionDate(r.txn_date)}</td>
                <td className="p-3 whitespace-nowrap font-semibold text-right" dir="ltr">
                  {formatILS(r.amount_signed)}
                </td>
                <td className="p-3">
                  <div className="font-medium">{r.merchant || r.description || "—"}</div>
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
    </>
  );
}

function sourceLabel(source, accountRef) {
  return formatSourceLabel(source, { cardLast4: accountRef });
}
