import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiDelete, apiGet } from "../api.js";
import toast from "react-hot-toast";

export default function Imports() {
  const [items, setItems] = useState([]);
  const [undoingId, setUndoingId] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const uploadInputRef = useRef(null);
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

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleUploadSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      setIsUploading(true);
      const response = await fetch("/api/imports/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let errorCode = "";
        try {
          const data = await response.json();
          errorCode = data?.error || "";
        } catch {
          errorCode = await response.text();
        }

        if (errorCode === "already_imported") {
          toast.error("הקובץ כבר יובא בעבר.");
        } else if (errorCode === "invalid_extension") {
          toast.error("יש לבחור קובץ אקסל בפורמט XLS או XLSX.");
        } else {
          toast.error("נכשל ייבוא הקובץ.");
        }
        return;
      }

      toast.success("הקובץ הועבר לתיבת הייבוא.");
      await load();
    } catch (error) {
      console.error(error);
      toast.error("נכשל ייבוא הקובץ.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="font-semibold">יומני ייבוא (אחרונים)</div>
        <div className="flex items-center gap-2">
          <button className="btn" type="button" onClick={handleUploadClick} disabled={isUploading}>
            {isUploading ? "מייבא..." : "יבא תנועות"}
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={handleUploadSelected}
          />
        </div>
      </div>
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
