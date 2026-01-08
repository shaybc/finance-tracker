import React, { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api.js";

export default function Categories() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [err, setErr] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("");
  const [search, setSearch] = useState("");

  const filteredItems = items.filter((category) => {
    if (!search.trim()) return true;
    return (category.name_he || "").toLowerCase().includes(search.trim().toLowerCase());
  });

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

  function startEdit(category) {
    setEditingId(category.id);
    setEditName(category.name_he || "");
    setEditIcon(category.icon || "");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditIcon("");
  }

  async function saveEdit(id) {
    setErr("");
    try {
      await apiPatch(`/api/categories/${id}`, { name_he: editName, icon: editIcon || null });
      cancelEdit();
      await load();
    } catch (e) {
      setErr(String(e));
    }
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
        <div className="flex flex-col gap-2 mb-3">
          <div className="font-semibold">קטגוריות</div>
          <input
            className="input"
            placeholder="חיפוש לפי שם קטגוריה"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {filteredItems.map((c) => (
            <div key={c.id} className="border border-slate-200 rounded-xl p-3 flex items-center justify-between">
              {editingId === c.id ? (
                <div className="flex-1 space-y-2">
                  <input className="input w-full" value={editName} onChange={(e) => setEditName(e.target.value)} />
                  <input className="input w-24" value={editIcon} onChange={(e) => setEditIcon(e.target.value)} />
                  <div className="text-xs text-slate-500">id: {c.id}</div>
                </div>
              ) : (
                <div>
                  <div className="font-medium">{c.icon ? `${c.icon} ` : ""}{c.name_he}</div>
                  <div className="text-xs text-slate-500">id: {c.id}</div>
                </div>
              )}
              <div className="flex items-center gap-2">
                {editingId === c.id ? (
                  <>
                    <button className="btn" onClick={() => saveEdit(c.id)}>שמור</button>
                    <button className="btn" onClick={cancelEdit}>בטל</button>
                  </>
                ) : (
                  <>
                    <button className="btn" onClick={() => startEdit(c)}>ערוך</button>
                    <button className="btn" onClick={() => del(c.id)}>מחק</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
