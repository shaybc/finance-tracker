import React, { useState, useEffect, useRef } from "react";
import { formatILS } from "../utils/format.js";
import { apiPost } from "../api.js";
import toast from "react-hot-toast";

export default function TransactionsTable({ rows, categories, onUpdateCategory, onFilterByDescription, onFilterByDirection, onFilterByMonth }) {
  const [contextMenu, setContextMenu] = useState(null);
  const [showCategorySubmenu, setShowCategorySubmenu] = useState(false);
  const [isCreatingRule, setIsCreatingRule] = useState(false);
  const menuRef = useRef(null);

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
        setShowCategorySubmenu(false);
      }
    }

    if (contextMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [contextMenu]);

  // Close menu on scroll (but not if scrolling inside the submenu)
  useEffect(() => {
    function handleScroll(e) {
      // Don't close if scrolling inside the submenu
      if (menuRef.current && menuRef.current.contains(e.target)) {
        return;
      }
      setContextMenu(null);
      setShowCategorySubmenu(false);
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
    setShowCategorySubmenu(false);
  }

  function handleFilterByDescription(transaction) {
    const description = transaction.merchant || transaction.description || "";
    if (description) {
      onFilterByDescription(description);
      setContextMenu(null);
      setShowCategorySubmenu(false);
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
      setShowCategorySubmenu(false);
      toast.success(`מסנן לפי קטגוריה: "${category?.name_he || transaction.category_id}"`);
    } else {
      toast.error("אין קטגוריה לתנועה זו");
    }
  }

  function handleFilterByDirection(direction) {
    onFilterByDirection(direction);
    setContextMenu(null);
    setShowCategorySubmenu(false);
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
    setShowCategorySubmenu(false);
    
    const monthNames = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
    toast.success(`מסנן עבור ${monthNames[month - 1]} ${year}`);
  }

  async function createRuleFromTransaction(transaction, categoryId) {
    setIsCreatingRule(true);
    
    try {
      // Get the text to use for the pattern (merchant or description)
      const pattern = transaction.merchant || transaction.description || "";
      
      if (!pattern) {
        toast.error("לא ניתן לקבוע חוק - אין תיאור או בית עסק");
        setIsCreatingRule(false);
        return;
      }

      const category = categories.find(c => c.id === categoryId);
      const ruleName = `${pattern} → ${category?.name_he || 'קטגוריה'}`;

      await apiPost("/api/rules", {
        name: ruleName,
        match_field: "merchant",
        match_type: "contains",
        pattern: pattern,
        source: transaction.source || null,
        direction: transaction.direction || null,
        category_id: categoryId,
      });

      toast.success(`חוק נוצר: "${pattern}" → ${category?.name_he}`);
      setContextMenu(null);
      setShowCategorySubmenu(false);

      // Trigger reload of rules
      window.dispatchEvent(new CustomEvent('reload-rules'));
    } catch (err) {
      console.error("Failed to create rule:", err);
      toast.error("שגיאה ביצירת החוק");
    } finally {
      setIsCreatingRule(false);
    }
  }

  return (
    <>
      <div className="card overflow-hidden">
        <table className="table">
          <thead className="bg-slate-100">
            <tr className="text-right">
              <th className="p-3">תאריך</th>
              <th className="p-3">סכום</th>
              <th className="p-3">תיאור/בית עסק</th>
              <th className="p-3">קטגוריה</th>
              <th className="p-3">מקור</th>
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
                <td className="p-3 whitespace-nowrap text-xs text-slate-600">{sourceLabel(r.source)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="p-6 text-center text-slate-500" colSpan={5}>אין נתונים להצגה</td>
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
            onMouseEnter={() => setShowCategorySubmenu(true)}
          >
            <span>צור חוק מהתיאור</span>
            <span className="text-slate-400">◀</span>
          </div>

          {/* Submenu for categories */}
          {showCategorySubmenu && (
            <div
              className="absolute bg-white border border-slate-200 rounded-xl shadow-lg py-1 max-h-96 overflow-y-auto"
              style={{
                right: "100%",
                top: "0",
                marginRight: "4px",
                minWidth: "200px",
              }}
              onMouseLeave={() => setShowCategorySubmenu(false)}
            >
              {categories.map((cat) => (
                <div
                  key={cat.id}
                  className="px-4 py-2 hover:bg-slate-100 cursor-pointer"
                  onClick={() => createRuleFromTransaction(contextMenu.row, cat.id)}
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
    </>
  );
}

function sourceLabel(source) {
  if (source === "bank") return "בנק";
  if (source === "visa_portal") return "ויזה (פורטל)";
  if (source === "max") return "מקס";
  return source;
}
