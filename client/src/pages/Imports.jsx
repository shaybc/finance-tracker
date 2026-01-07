import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiDelete, apiGet } from "../api.js";
import toast from "react-hot-toast";

export default function Imports() {
  const [items, setItems] = useState([]);
  const [undoingId, setUndoingId] = useState(null);
  const navigate = useNavigate();

  async function load() {
    const res = await apiGet("/api/imports");
    setItems(res.items || []);
  }

  useEffect(() => {
    load().catch(console.error);
    const t = setInterval(() => load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, []);

  async function handleUndo(item) {
    if (!item.finished_at) {
      toast.error("הייבוא עדיין בתהליך.");
      return;
    }
    const confirmed = window.confirm(`לבטל את הייבוא של ${item.file_name}?`);
    if (!confirmed) return;

    try {
      setUndoingId(item.id);
      await apiDelete(`/api/imports/${item.id}`);
      toast.success("הייבוא בוטל והעסקאות הוסרו.");
      await load();
    } catch (error) {
      console.error(error);
      toast.error("נכשל ביטול הייבוא.");
    } finally {
      setUndoingId(null);
    }
  }

  return (
    <div className="card p-4">
      <div className="font-semibold mb-3">יומני ייבוא (אחרונים)</div>
      <div className="overflow-auto">
        <table className="table">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-3">מזהה</th>
              <th className="p-3">קובץ</th>
              <th className="p-3">מקור</th>
              <th className="p-3">התווספו</th>
              <th className="p-3">כפילויות</th>
              <th className="p-3">שגיאות</th>
              <th className="p-3">סיום</th>
              <th className="p-3">פעולות</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr
                key={i.id}
                className="border-t border-slate-200 hover:bg-slate-50 cursor-pointer"
                onClick={() => navigate(`/imports/${i.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    navigate(`/imports/${i.id}`);
                  }
                }}
              >
                <td className="p-3">{i.id}</td>
                <td className="p-3">{i.file_name}</td>
                <td className="p-3">{i.source}</td>
                <td className="p-3">{i.rows_inserted}</td>
                <td className="p-3">{i.rows_duplicates}</td>
                <td className="p-3">{i.rows_failed}</td>
                <td className="p-3 text-xs text-slate-600">{i.finished_at || "בתהליך..."}</td>
                <td className="p-3">
                  <button
                    className="btn text-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleUndo(i);
                    }}
                    disabled={!i.finished_at || undoingId === i.id}
                  >
                    בטל ייבוא
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td className="p-6 text-center text-slate-500" colSpan={8}>אין ייבואים עדיין.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
