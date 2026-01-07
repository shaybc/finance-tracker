import React, { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../api.js";

export default function Categories() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [err, setErr] = useState("");

  async function load() {
    const res = await apiGet("/api/categories");
    setItems(res.items || []);
  }

  useEffect(() => { load().catch(console.error); }, []);

  async function add() {
    setErr("");
    try {
      await apiPost("/api/categories", { name_he: name, icon: icon || null });
      setName("");
      setIcon("");
      await load();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function del(id) {
    await apiDelete(`/api/categories/${id}`);
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="font-semibold mb-2">הוספת קטגוריה</div>
        <div className="flex flex-col md:flex-row gap-2">
          <input className="input flex-1" placeholder="שם (למשל: חשבונות)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input w-24" placeholder="אייקון" value={icon} onChange={(e) => setIcon(e.target.value)} />
          <button className="btn" onClick={add}>הוסף</button>
        </div>
        {err && <div className="text-sm text-red-600 mt-2">{err}</div>}
      </div>

      <div className="card p-4">
        <div className="font-semibold mb-3">קטגוריות</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {items.map((c) => (
            <div key={c.id} className="border border-slate-200 rounded-xl p-3 flex items-center justify-between">
              <div>
                <div className="font-medium">{c.icon ? `${c.icon} ` : ""}{c.name_he}</div>
                <div className="text-xs text-slate-500">id: {c.id}</div>
              </div>
              <button className="btn" onClick={() => del(c.id)}>מחק</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
