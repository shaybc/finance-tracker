import React, { useRef } from "react";
import toast from "react-hot-toast";

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

  const handleExport = async () => {
    try {
      await downloadRulesAndCategories();
      toast.success("הקובץ הורד בהצלחה.");
    } catch (error) {
      toast.error("נכשל ייצוא חוקים וקטגוריות.");
    }
  };

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleImportSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const confirmed = window.confirm("לייבא חוקים וקטגוריות מהקובץ? פעולה זו תמחק את הקיים.");
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
      toast.success("החוקים והקטגוריות יובאו בהצלחה.");
    } catch (error) {
      toast.error("נכשל ייבוא חוקים וקטגוריות.");
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

  return (
    <div className="card p-5 space-y-6">
      <div className="text-lg font-semibold">הגדרות</div>

      <section className="space-y-2">
        <div className="font-semibold">חוקים וקטגוריות</div>
        <p className="text-sm text-slate-500">
          ניתן לייצא חוקים וקטגוריות לקובץ גיבוי, או לייבא אותם מקובץ קיים.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn" type="button" onClick={handleExport}>
            ייצוא חוקים &amp; קטגוריות
          </button>
          <button className="btn" type="button" onClick={handleImportClick}>
            ייבוא חוקים &amp; קטגוריות
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
    </div>
  );
}
