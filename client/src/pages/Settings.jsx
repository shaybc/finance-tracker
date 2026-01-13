import React, { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { apiGet } from "../api.js";
import { DASHBOARD_RANGE_OPTIONS, resolveDashboardRange } from "../utils/dashboardRange.js";
import {
  DEFAULT_TRANSACTION_COLORING,
  TRANSACTIONS_PAGE_SIZE_OPTIONS,
  resolveTransactionsPageSizeOption,
} from "../utils/transactions.js";

async function downloadRulesAndCategories() {
  const response = await fetch("/api/settings/rules-categories/export");
  if (!response.ok) throw new Error(await response.text());

  const blob = await response.blob();
  const contentDisposition = response.headers.get("content-disposition") || "";
  const match = contentDisposition.match(/filename="([^"]+)"/);
  const fileName = match?.[1] || "rules_categories.json";

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

export default function Settings() {
  const importInputRef = useRef(null);
  const [openingBalance, setOpeningBalance] = useState("");
  const [openingBalanceLoaded, setOpeningBalanceLoaded] = useState(false);
  const defaultPageSizeOption =
    resolveTransactionsPageSizeOption("50") || TRANSACTIONS_PAGE_SIZE_OPTIONS[0];
  const [defaultPageSize, setDefaultPageSize] = useState(
    defaultPageSizeOption?.value || "50"
  );
  const storedDashboardRange = resolveDashboardRange(
    window.localStorage?.getItem("dashboard.range.default")
  );
  const [defaultDashboardRange, setDefaultDashboardRange] = useState(storedDashboardRange || "custom");
  const [dashboardRangeLoaded, setDashboardRangeLoaded] = useState(false);
  const [transactionColoring, setTransactionColoring] = useState(
    DEFAULT_TRANSACTION_COLORING
  );
  const [transactionColoringLoaded, setTransactionColoringLoaded] = useState(false);

  useEffect(() => {
    let isMounted = true;
    apiGet("/api/settings/opening-balance")
      .then((data) => {
        if (!isMounted) return;
        const value =
          data?.openingBalance === null || data?.openingBalance === undefined
            ? ""
            : String(data.openingBalance);
        setOpeningBalance(value);
        setOpeningBalanceLoaded(true);
      })
      .catch(() => {
        if (!isMounted) return;
        setOpeningBalanceLoaded(true);
        toast.error("נכשל לטעון יתרת פתיחה.");
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    apiGet("/api/settings/transactions-page-size")
      .then((data) => {
        if (!isMounted) return;
        const storedOption = resolveTransactionsPageSizeOption(data?.pageSizeDefault);
        if (storedOption) {
          setDefaultPageSize(storedOption.value);
        }
      })
      .catch(() => {
        if (!isMounted) return;
        toast.error("נכשל לטעון ברירת מחדל לשורות.");
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    apiGet("/api/settings/dashboard-range")
      .then((data) => {
        if (!isMounted) return;
        const value = resolveDashboardRange(data?.rangePreset);
        if (value) {
          setDefaultDashboardRange(value);
          window.localStorage?.setItem("dashboard.range.default", value);
        }
        setDashboardRangeLoaded(true);
      })
      .catch(() => {
        if (!isMounted) return;
        setDashboardRangeLoaded(true);
        toast.error("נכשל לטעון ברירת מחדל לטווח דשבורד.");
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    apiGet("/api/settings/transactions-coloring")
      .then((data) => {
        if (!isMounted) return;
        setTransactionColoring({
          enabled: Boolean(data?.enabled),
          incomeColor: data?.incomeColor || DEFAULT_TRANSACTION_COLORING.incomeColor,
          expenseColor: data?.expenseColor || DEFAULT_TRANSACTION_COLORING.expenseColor,
        });
        setTransactionColoringLoaded(true);
      })
      .catch(() => {
        if (!isMounted) return;
        setTransactionColoringLoaded(true);
        toast.error("נכשל לטעון הגדרות צביעה לתנועות.");
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const handleDefaultPageSizeChange = async (nextSize) => {
    setDefaultPageSize(nextSize);
    try {
      const response = await fetch("/api/settings/transactions-page-size", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageSizeDefault: nextSize }),
      });
      if (!response.ok) throw new Error(await response.text());
      toast.success("ברירת המחדל נשמרה.");
    } catch (error) {
      toast.error("נכשל לשמור ברירת מחדל לשורות.");
    }
  };

  const handleDefaultDashboardRangeChange = async (nextValue) => {
    setDefaultDashboardRange(nextValue);
    window.localStorage?.setItem("dashboard.range.default", nextValue);
    try {
      const response = await fetch("/api/settings/dashboard-range", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rangePreset: nextValue }),
      });
      if (!response.ok) throw new Error(await response.text());
      toast.success("ברירת המחדל נשמרה.");
    } catch (error) {
      toast.error("נכשל לשמור ברירת מחדל לטווח דשבורד.");
    }
  };

  const saveTransactionColoring = async (nextValue) => {
    try {
      const response = await fetch("/api/settings/transactions-coloring", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextValue),
      });
      if (!response.ok) throw new Error(await response.text());
      toast.success("הגדרות הצביעה נשמרו.");
    } catch (error) {
      toast.error("נכשל לשמור הגדרות צביעה לתנועות.");
    }
  };

  const handleTransactionColoringChange = (updates) => {
    setTransactionColoring((prev) => {
      const nextValue = { ...prev, ...updates };
      saveTransactionColoring(nextValue);
      return nextValue;
    });
  };

  const handleExport = async () => {
    try {
      await downloadRulesAndCategories();
      toast.success("הקובץ הורד בהצלחה.");
    } catch (error) {
      toast.error("נכשל ייצוא חוקים, קטגוריות ותגים.");
    }
  };

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleImportSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const confirmed = window.confirm(
      "לייבא חוקים, קטגוריות ותגים מהקובץ? פעולה זו תמחק את הקיים."
    );
    if (!confirmed) return;

    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const response = await fetch("/api/settings/rules-categories/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await response.text());
      toast.success("החוקים, הקטגוריות והתגים יובאו בהצלחה.");
    } catch (error) {
      toast.error("נכשל ייבוא חוקים, קטגוריות ותגים.");
    }
  };

  const handleClearCategories = async () => {
    const confirmed = window.confirm("להסיר קטגוריות מכל העסקאות?");
    if (!confirmed) return;

    try {
      const response = await fetch("/api/settings/clear-categories", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      toast.success("כל הקטגוריות הוסרו מהעסקאות.");
    } catch (error) {
      toast.error("נכשל ניקוי קטגוריות.");
    }
  };

  const handleClearTags = async () => {
    const confirmed = window.confirm("להסיר תגים מכל העסקאות?");
    if (!confirmed) return;

    try {
      const response = await fetch("/api/settings/clear-tags", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      toast.success("כל התגים הוסרו מהעסקאות.");
    } catch (error) {
      toast.error("נכשל ניקוי תגים.");
    }
  };

  const handleBackup = async () => {
    const destination = window.prompt("בחרו נתיב תיקייה לגיבוי:");
    if (!destination) return;

    try {
      const response = await fetch("/api/settings/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      toast.success(`הגיבוי נשמר בתיקייה ${data.folder_name}.`);
    } catch (error) {
      toast.error("נכשל גיבוי בסיס הנתונים.");
    }
  };

  const handleRestore = async () => {
    const source = window.prompt("בחרו נתיב תיקיית גיבוי לשחזור:");
    if (!source) return;

    const confirmed = window.confirm("לשחזר את בסיס הנתונים מהגיבוי? הפעולה תדרוס את הנתונים הנוכחיים.");
    if (!confirmed) return;

    try {
      const response = await fetch("/api/settings/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      if (!response.ok) throw new Error(await response.text());
      toast.success("השחזור הסתיים בהצלחה.");
    } catch (error) {
      toast.error("נכשל שחזור בסיס הנתונים.");
    }
  };

  const handleResetDatabase = async () => {
    const confirmed = window.confirm(
      "לאפס את בסיס הנתונים להגדרות יצרן? פעולה זו תמחק את כל הטבלאות, הנתונים, העסקאות, הקבצים שיובאו והכללים."
    );
    if (!confirmed) return;

    try {
      const response = await fetch("/api/settings/reset", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      toast.success("המערכת אופסה להגדרות יצרן.");
    } catch (error) {
      toast.error("נכשל איפוס בסיס הנתונים.");
    }
  };

  const handleOpeningBalanceSave = async () => {
    try {
      const response = await fetch("/api/settings/opening-balance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openingBalance: openingBalance === "" ? null : openingBalance,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      setOpeningBalance(
        data?.openingBalance === null || data?.openingBalance === undefined
          ? ""
          : String(data.openingBalance)
      );
      toast.success("יתרת הפתיחה עודכנה.");
    } catch (error) {
      toast.error("נכשל עדכון יתרת פתיחה.");
    }
  };

  return (
    <div className="card p-5 space-y-6">
      <div className="text-lg font-semibold">הגדרות</div>

      <section className="space-y-2">
        <div className="font-semibold">יתרת פתיחה</div>
        <p className="text-sm text-slate-500">
          יתרת פתיחה תתווסף לסכום הכולל כאשר לא מופעלים סינונים בטבלת העסקאות.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input w-56"
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={openingBalance}
            onChange={(event) => setOpeningBalance(event.target.value)}
            disabled={!openingBalanceLoaded}
          />
          <button
            className="btn"
            type="button"
            onClick={handleOpeningBalanceSave}
            disabled={!openingBalanceLoaded}
          >
            שמירה
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="font-semibold">ברירת מחדל לשורות בטבלת עסקאות</div>
        <p className="text-sm text-slate-500">
          בחרו כמה שורות יוצגו כברירת מחדל בעמוד העסקאות.
        </p>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          שורות להציג
          <select
            className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
            value={defaultPageSize}
            onChange={(event) => {
              const nextValue = event.target.value;
              handleDefaultPageSizeChange(nextValue);
            }}
          >
            {TRANSACTIONS_PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="space-y-2">
        <div className="font-semibold">ברירת מחדל לטווח בדשבורד</div>
        <p className="text-sm text-slate-500">
          בחרו את טווח הימים שיוצג כברירת מחדל לצד מסנני התאריכים בדשבורד.
        </p>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          טווח להציג
          <select
            className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
            value={defaultDashboardRange}
            onChange={(event) => handleDefaultDashboardRangeChange(event.target.value)}
            disabled={!dashboardRangeLoaded}
          >
            {DASHBOARD_RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="space-y-2">
        <div className="font-semibold">צביעת סכומי תנועות</div>
        <p className="text-sm text-slate-500">
          כאשר מסומן, סכומי ההכנסות וההוצאות יצבעו לפי הכיוון.
        </p>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={transactionColoring.enabled}
            onChange={(event) =>
              handleTransactionColoringChange({ enabled: event.target.checked })
            }
            disabled={!transactionColoringLoaded}
          />
          צבע תנועות לפי כיוון
        </label>
        <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
          <label className="flex items-center gap-2">
            צבע הכנסות
            <input
              type="color"
              value={transactionColoring.incomeColor}
              onChange={(event) =>
                handleTransactionColoringChange({ incomeColor: event.target.value })
              }
              disabled={!transactionColoringLoaded}
            />
          </label>
          <label className="flex items-center gap-2">
            צבע הוצאות
            <input
              type="color"
              value={transactionColoring.expenseColor}
              onChange={(event) =>
                handleTransactionColoringChange({ expenseColor: event.target.value })
              }
              disabled={!transactionColoringLoaded}
            />
          </label>
        </div>
      </section>

      <section className="space-y-2">
        <div className="font-semibold">חוקים, קטגוריות ותגים</div>
        <p className="text-sm text-slate-500">
          ניתן לייצא חוקים, קטגוריות ותגים לקובץ גיבוי, או לייבא אותם מקובץ קיים.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn" type="button" onClick={handleExport}>
            ייצוא חוקים, קטגוריות ותגים
          </button>
          <button className="btn" type="button" onClick={handleImportClick}>
            ייבוא חוקים, קטגוריות ותגים
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={handleImportSelected}
          />
        </div>
      </section>

      <section className="space-y-2">
        <div className="font-semibold">קטגוריות עסקאות</div>
        <p className="text-sm text-slate-500">
          מאפס את שיוך הקטגוריות בכל העסקאות ומחזיר אותן לבלתי מסווגות.
        </p>
        <button className="btn" type="button" onClick={handleClearCategories}>
          נקה קטגוריות
        </button>
      </section>

      <section className="space-y-2">
        <div className="font-semibold">תגים עסקאות</div>
        <p className="text-sm text-slate-500">מסיר את כל התגים מכל העסקאות.</p>
        <button className="btn" type="button" onClick={handleClearTags}>
          נקה תגים
        </button>
      </section>

      <section className="space-y-2">
        <div className="font-semibold">גיבוי בסיס נתונים</div>
        <p className="text-sm text-slate-500">
          הגיבוי יישמר בתיקייה בשם <span className="font-mono">finance_tracker_db</span> עם תאריך ושעה.
        </p>
        <button className="btn" type="button" onClick={handleBackup}>
          גיבוי בסיס נתונים
        </button>
      </section>

      <section className="space-y-2">
        <div className="font-semibold">שחזור בסיס נתונים</div>
        <p className="text-sm text-slate-500">
          שחזור מוחק את בסיס הנתונים הנוכחי ומחליף אותו בקבצי הגיבוי.
        </p>
        <button className="btn" type="button" onClick={handleRestore}>
          שחזור בסיס נתונים
        </button>
      </section>

      <section className="space-y-2">
        <div className="font-semibold">איפוס מלא</div>
        <p className="text-sm text-slate-500">
          מאפס את בסיס הנתונים להגדרות יצרן ומוחק את כל הטבלאות, הנתונים, העסקאות, הקבצים
          שיובאו והכללים.
        </p>
        <button
          className="btn !bg-red-600 !text-white !border-red-600 hover:!bg-red-700 font-bold"
          type="button"
          onClick={handleResetDatabase}
        >
          איפוס כל הנתונים
        </button>
      </section>
    </div>
  );
}
