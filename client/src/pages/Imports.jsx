import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiDelete, apiGet } from "../api.js";
import toast from "react-hot-toast";
import { PAGE_SIZE_OPTIONS } from "../utils/transactions.js";

export default function Imports() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [undoingId, setUndoingId] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isEditingPage, setIsEditingPage] = useState(false);
  const [pageValue, setPageValue] = useState("1");
  const uploadInputRef = useRef(null);
  const pageInputRef = useRef(null);
  const navigate = useNavigate();

  async function load(targetPage = page) {
    const qs = new URLSearchParams({
      page: String(targetPage),
      pageSize: String(pageSize),
    }).toString();
    const res = await apiGet(`/api/imports?${qs}`);
    setItems(res.items || []);
    setTotal(res.total || 0);
    setPage(res.page || targetPage);
  }

  useEffect(() => {
    load(page).catch(console.error);
    const t = setInterval(() => load(page).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [page, pageSize]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((total || 0) / pageSize)),
    [total, pageSize]
  );

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  useEffect(() => {
    if (!isEditingPage) {
      setPageValue(String(page));
    }
  }, [page, isEditingPage]);

  useEffect(() => {
    if (isEditingPage && pageInputRef.current) {
      pageInputRef.current.focus({ preventScroll: true });
      pageInputRef.current.select();
    }
  }, [isEditingPage]);

  function commitPageChange() {
    const parsedPage = Number.parseInt(pageValue, 10);
    if (Number.isNaN(parsedPage)) {
      setIsEditingPage(false);
      setPageValue(String(page));
      return;
    }
    const nextPage = Math.min(Math.max(parsedPage, 1), totalPages);
    setIsEditingPage(false);
    setPageValue(String(nextPage));
    if (nextPage !== page) {
      setPage(nextPage);
    }
  }

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
      await load(page);
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
      await load(page);
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
        <div className="font-semibold">יומני ייבוא</div>
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
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
        <div>סה״כ ייבואים: {total.toLocaleString("he-IL")}</div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            שורות להציג
            <select
              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
              value={pageSize}
              onChange={(event) => {
                setPage(1);
                setPageSize(Number(event.target.value));
                setIsEditingPage(false);
                setPageValue("1");
              }}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            הקודם
          </button>
          {isEditingPage ? (
            <input
              className="h-9 w-20 rounded-lg border border-slate-200 bg-white px-2 text-center text-sm shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
              ref={pageInputRef}
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
            />
          ) : (
            <button
              type="button"
              className="text-sm text-slate-700 underline decoration-dotted underline-offset-4"
              onClick={() => {
                setPageValue(String(page));
                setIsEditingPage(true);
              }}
            >
              עמוד {page} מתוך {totalPages}
            </button>
          )}
          <button
            className="btn"
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            הבא
          </button>
        </div>
      </div>
    </div>
  );
}
