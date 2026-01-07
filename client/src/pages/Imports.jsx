import React, { useEffect, useState } from "react";
import { apiGet } from "../api.js";

export default function Imports() {
  const [items, setItems] = useState([]);

  async function load() {
    const res = await apiGet("/api/imports");
    setItems(res.items || []);
  }

  useEffect(() => {
    load().catch(console.error);
    const t = setInterval(() => load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, []);

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
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-t border-slate-200">
                <td className="p-3">{i.id}</td>
                <td className="p-3">{i.file_name}</td>
                <td className="p-3">{i.source}</td>
                <td className="p-3">{i.rows_inserted}</td>
                <td className="p-3">{i.rows_duplicates}</td>
                <td className="p-3">{i.rows_failed}</td>
                <td className="p-3 text-xs text-slate-600">{i.finished_at || "בתהליך..."}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td className="p-6 text-center text-slate-500" colSpan={7}>אין ייבואים עדיין.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
