import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { apiDelete, apiGet } from "../api.js";
import { formatILS } from "../utils/format.js";

const SOURCE_LABELS = {
  bank: "bank",
  max: "max",
  visa_portal: "visa",
};

export default function ImportDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isCanceling, setIsCanceling] = useState(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      try {
        const res = await apiGet(`/api/imports/${id}`);
        if (alive) setData(res);
      } catch (error) {
        console.error(error);
        toast.error("לא ניתן לטעון את פרטי הייבוא.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [id]);

  const item = data?.item;
  const typeLabel = useMemo(() => SOURCE_LABELS[item?.source] || item?.source || "—", [item?.source]);

  async function handleCancelImport() {
    if (!item?.finished_at) {
      toast.error("הייבוא עדיין בתהליך.");
      return;
    }
    const confirmed = window.confirm(`לבטל את הייבוא של ${item?.file_name}?`);
    if (!confirmed) return;

    try {
      setIsCanceling(true);
      await apiDelete(`/api/imports/${item.id}`);
      toast.success("הייבוא בוטל והעסקאות הוסרו.");
      navigate("/imports");
    } catch (error) {
      console.error(error);
      toast.error("נכשל ביטול הייבוא.");
    } finally {
      setIsCanceling(false);
    }
  }

  function handleOpenFile() {
    if (data?.file_url) {
      window.open(data.file_url, "_blank", "noopener,noreferrer");
    }
  }

  if (loading) {
    return <div className="card p-4">טוען פרטי ייבוא...</div>;
  }

  if (!item) {
    return <div className="card p-4">ייבוא לא נמצא.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="card p-4">
        <div className="font-semibold mb-4">פרטי ייבוא</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-slate-500">סוג קובץ</div>
            <div className="font-medium">{typeLabel}</div>
          </div>
          <div>
            <div className="text-slate-500">שם קובץ</div>
            <div className="font-medium break-all">{item.file_name}</div>
          </div>
          <div>
            <div className="text-slate-500">תאריך ייבוא</div>
            <div className="font-medium">{item.finished_at || item.started_at || "—"}</div>
          </div>
          <div>
            <div className="text-slate-500">סה״כ רשומות בקובץ</div>
            <div className="font-medium">{item.rows_total ?? 0}</div>
          </div>
          <div>
            <div className="text-slate-500">סה״כ רשומות שיובאו</div>
            <div className="font-medium">{item.rows_inserted ?? 0}</div>
          </div>
          <div>
            <div className="text-slate-500">סה״כ כפילויות שהתעלמנו מהן</div>
            <div className="font-medium">{item.rows_duplicates ?? 0}</div>
          </div>
          <div>
            <div className="text-slate-500">סה״כ שגיאות בעיבוד</div>
            <div className="font-medium">{item.rows_failed ?? 0}</div>
          </div>
          <div>
            <div className="text-slate-500">תאריך הרשומה הראשונה</div>
            <div className="font-medium">{data?.stats?.first_entry_date || "—"}</div>
          </div>
          <div>
            <div className="text-slate-500">תאריך הרשומה האחרונה</div>
            <div className="font-medium">{data?.stats?.last_entry_date || "—"}</div>
          </div>
          {item.source === "bank" && (
            <div>
              <div className="text-slate-500">מספר חשבון</div>
              <div className="font-medium">{data?.account_ref || "—"}</div>
            </div>
          )}
          {item.source !== "bank" && (
            <div>
              <div className="text-slate-500">4 ספרות אחרונות</div>
              <div className="font-medium">{data?.card_last4 || "—"}</div>
            </div>
          )}
        </div>
      </div>

      <div className="card p-4">
        <div className="font-semibold mb-3">כפילויות שהתעלמנו מהן</div>
        <div className="overflow-auto">
          <table className="table">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-3">תאריך</th>
                <th className="p-3">סכום</th>
                <th className="p-3">תיאור/בית עסק</th>
                <th className="p-3">קטגוריה מקורית</th>
              </tr>
            </thead>
            <tbody>
              {(data?.duplicates || []).map((dup) => (
                <tr key={dup.id} className="border-t border-slate-200">
                  <td className="p-3 whitespace-nowrap">{dup.txn_date || "—"}</td>
                  <td className="p-3 whitespace-nowrap font-semibold">{formatILS(dup.amount_signed)}</td>
                  <td className="p-3">
                    <div className="font-medium">{dup.merchant || dup.description || "—"}</div>
                    <div className="text-xs text-slate-500">{dup.description && dup.merchant ? dup.description : ""}</div>
                  </td>
                  <td className="p-3 whitespace-nowrap text-xs text-slate-600">{dup.category_raw || "—"}</td>
                </tr>
              ))}
              {(data?.duplicates || []).length === 0 && (
                <tr>
                  <td className="p-6 text-center text-slate-500" colSpan={4}>
                    אין כפילויות להצגה.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          className="btn flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          type="button"
          onClick={handleOpenFile}
          disabled={!data?.file_available}
        >
          <span aria-hidden="true">📂</span>
          פתח קובץ
        </button>
        <button
          className="btn text-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
          type="button"
          onClick={handleCancelImport}
          disabled={!item.finished_at || isCanceling}
        >
          בטל ייבוא
        </button>
        <button className="btn" type="button" onClick={() => navigate("/imports")}>
          סגור
        </button>
      </div>
    </div>
  );
}
