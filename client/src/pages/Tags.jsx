import React, { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api.js";

export default function Tags() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [err, setErr] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("");
  const [search, setSearch] = useState("");

  const filteredItems = items.filter((tag) => {
    if (!search.trim()) return true;
    return (tag.name_he || "").toLowerCase().includes(search.trim().toLowerCase());
  });

  async function load() {
    const res = await apiGet("/api/tags");
    setItems(res.items || []);
  }

  useEffect(() => { load().catch(console.error); }, []);

  async function add() {
    setErr("");
    try {
      await apiPost("/api/tags", { name_he: name, icon: icon || null });
      setName("");
      setIcon("");
      await load();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function del(id) {
    await apiDelete(`/api/tags/${id}`);
    await load();
  }

  function startEdit(tag) {
    setEditingId(tag.id);
    setEditName(tag.name_he || "");
    setEditIcon(tag.icon || "");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditIcon("");
  }

  async function saveEdit(id) {
    setErr("");
    try {
      await apiPatch(`/api/tags/${id}`, { name_he: editName, icon: editIcon || null });
      cancelEdit();
      await load();
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="font-semibold mb-2">הוספת תג</div>
        <div className="flex flex-col md:flex-row gap-2">
          <input className="input flex-1" placeholder="שם (למשל: ביטוח רכב)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input w-24" placeholder="אייקון" value={icon} onChange={(e) => setIcon(e.target.value)} />
          <button className="btn" onClick={add}>הוסף</button>
        </div>
        {err && <div className="text-sm text-red-600 mt-2">{err}</div>}
      </div>

      <div className="card p-4">
        <div className="flex flex-col gap-2 mb-3">
          <div className="font-semibold">תגים</div>
          <input
            className="input"
            placeholder="חיפוש לפי שם תג"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {filteredItems.map((tag) => (
            <div key={tag.id} className="border border-slate-200 rounded-xl p-3 flex items-center justify-between">
              {editingId === tag.id ? (
                <div className="flex-1 space-y-2">
                  <input className="input w-full" value={editName} onChange={(e) => setEditName(e.target.value)} />
                  <input className="input w-24" value={editIcon} onChange={(e) => setEditIcon(e.target.value)} />
                  <div className="text-xs text-slate-500">id: {tag.id}</div>
                </div>
              ) : (
                <div>
                  <div className="font-medium">{tag.icon ? `${tag.icon} ` : ""}{tag.name_he}</div>
                  <div className="text-xs text-slate-500">id: {tag.id}</div>
                </div>
              )}
              <div className="flex items-center gap-2">
                {editingId === tag.id ? (
                  <>
                    <button className="btn" onClick={() => saveEdit(tag.id)}>שמור</button>
                    <button className="btn" onClick={cancelEdit}>בטל</button>
                  </>
                ) : (
                  <>
                    <button className="btn" onClick={() => startEdit(tag)}>ערוך</button>
                    <button className="btn" onClick={() => del(tag.id)}>מחק</button>
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
