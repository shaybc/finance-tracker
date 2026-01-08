import React, { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, apiDelete, apiPost as post } from "../api.js";
import toast from "react-hot-toast";
import { formatSourceLabel } from "../utils/source.js";

export default function Rules() {
  const [rules, setRules] = useState([]);
  const [cats, setCats] = useState([]);
  const [sources, setSources] = useState([]);
  const [isApplying, setIsApplying] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState("");

  const [form, setForm] = useState({
    name: "",
    match_field: "merchant",
    match_type: "contains",
    pattern: "",
    source: "",
    direction: "",
    category_id: "",
  });

  async function load() {
    const r = await apiGet("/api/rules");
    const c = await apiGet("/api/categories");
    const s = await apiGet("/api/sources");
    setRules(r.items || []);
    setCats(c.items || []);
    setSources(s.items || []);
  }

  useEffect(() => { load().catch(console.error); }, []);

  // Listen for reload events from other components
  useEffect(() => {
    const handleReload = () => load().catch(console.error);
    window.addEventListener('reload-rules', handleReload);
    return () => window.removeEventListener('reload-rules', handleReload);
  }, []);

  const filteredRules = rules.filter((rule) => {
    if (!search.trim()) return true;
    const query = search.trim().toLowerCase();
    return [
      rule.pattern,
      rule.name,
      rule.category_name,
    ].some((value) => (value || "").toLowerCase().includes(query));
  });

  async function addRule() {
    await apiPost("/api/rules", {
      name: form.name,
      match_field: form.match_field,
      match_type: form.match_type,
      pattern: form.pattern,
      source: form.source || null,
      direction: form.direction || null,
      category_id: Number(form.category_id),
    });
    setForm({ 
      name: "", 
      match_field: "merchant",
      match_type: "contains",
      pattern: "", 
      source: "",
      direction: "",
      category_id: ""
    });
    await load();
    toast.success("חוק נוסף בהצלחה");
  }

  async function updateRule() {
    await apiPatch(`/api/rules/${editingId}`, {
      name: form.name,
      match_field: form.match_field,
      match_type: form.match_type,
      pattern: form.pattern,
      source: form.source || null,
      direction: form.direction || null,
      category_id: Number(form.category_id),
    });
    setForm({ 
      name: "", 
      match_field: "merchant",
      match_type: "contains",
      pattern: "", 
      source: "",
      direction: "",
      category_id: ""
    });
    setEditingId(null);
    await load();
    toast.success("חוק עודכן בהצלחה");
  }

  function startEdit(rule) {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      match_field: rule.match_field,
      match_type: rule.match_type,
      pattern: rule.pattern,
      source: rule.source || "",
      direction: rule.direction || "",
      category_id: String(rule.category_id),
    });
    // Scroll to top to show the form
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm({ 
      name: "", 
      match_field: "merchant",
      match_type: "contains",
      pattern: "", 
      source: "",
      direction: "",
      category_id: ""
    });
  }

  async function toggle(id, enabled) {
    await apiPatch(`/api/rules/${id}`, { enabled: !enabled });
    await load();
  }

  async function del(id) {
    if (!confirm("האם למחוק חוק זה?")) return;
    await apiDelete(`/api/rules/${id}`);
    await load();
    toast.success("חוק נמחק");
  }

  async function applyAll() {
    setIsApplying(true);
    try {
      const res = await post("/api/rules/apply", {});
      const data = res.data ?? res;
      toast.success(`סווגו ${data.updated} מתוך ${data.scanned} תנועות`);
      await Promise.all([
        reloadTransactions(),
        reloadStats(),
        load()
      ]);
    } catch (err) {
      console.error("applyAll failed:", err);
      toast.error("שגיאה בהפעלת החוקים");
    } finally {
      setIsApplying(false);
    }
  }

  async function reloadTransactions() {
    window.dispatchEvent(new CustomEvent('reload-transactions'));
  }

  async function reloadStats() {
    window.dispatchEvent(new CustomEvent('reload-stats'));
  }
    
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">
            {editingId ? "עריכת חוק" : "חוקים לאוטומציה של קטגוריות"}
          </div>
          <button 
            onClick={applyAll} 
            disabled={isApplying} 
            className="px-4 py-2 bg-slate-900 text-white rounded-xl hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isApplying && (<span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />)}
            הפעל חוקים על לא-מסווגים
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
          <input 
            className="input md:col-span-2" 
            placeholder="שם חוק" 
            value={form.name} 
            onChange={(e) => setForm({ ...form, name: e.target.value })} 
          />

          <select 
            className="select" 
            value={form.match_field} 
            onChange={(e) => setForm({ ...form, match_field: e.target.value })}
          >
            <option value="merchant">תיאור/בית עסק</option>
            <option value="category_raw">קטגוריה מקורית</option>
          </select>

          <select 
            className="select" 
            value={form.match_type} 
            onChange={(e) => setForm({ ...form, match_type: e.target.value })}
          >
            <option value="contains">מכיל</option>
            <option value="equals">שווה</option>
            <option value="regex">Regex</option>
          </select>

          <input 
            className="input md:col-span-2" 
            placeholder="תבנית/מחרוזת" 
            value={form.pattern} 
            onChange={(e) => setForm({ ...form, pattern: e.target.value })} 
          />

          <select 
            className="select" 
            value={form.source} 
            onChange={(e) => setForm({ ...form, source: e.target.value })}
          >
            <option value="">כל המקורות</option>
            <option value="bank">{formatSourceLabel("bank")}</option>
            {Array.from(new Set(sources.filter(Boolean)))
              .filter((value) => value !== "bank")
              .map((value) => (
                <option key={value} value={value}>
                  {formatSourceLabel(value)}
                </option>
              ))}
          </select>

          <select 
            className="select" 
            value={form.direction} 
            onChange={(e) => setForm({ ...form, direction: e.target.value })}
          >
            <option value="">הכנסה+הוצאה</option>
            <option value="expense">הוצאה</option>
            <option value="income">הכנסה</option>
          </select>

          <select 
            className="select md:col-span-2" 
            value={form.category_id} 
            onChange={(e) => setForm({ ...form, category_id: e.target.value })}
          >
            <option value="">בחר קטגוריה</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon ? `${c.icon} ` : ""}{c.name_he}
              </option>
            ))}
          </select>

          {editingId ? (
            <>
              <button 
                className="btn md:col-span-3" 
                disabled={!form.name || !form.pattern || !form.category_id} 
                onClick={updateRule}
              >
                עדכן חוק
              </button>
              <button 
                className="btn md:col-span-3" 
                onClick={cancelEdit}
              >
                ביטול
              </button>
            </>
          ) : (
            <button 
              className="btn md:col-span-6" 
              disabled={!form.name || !form.pattern || !form.category_id} 
              onClick={addRule}
            >
              הוסף חוק
            </button>
          )}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-col gap-2 mb-3">
          <div className="font-semibold">רשימת חוקים</div>
          <input
            className="input"
            placeholder="חיפוש לפי שם, תבנית או קטגוריה"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          {filteredRules.map((r) => (
            <div 
              key={r.id} 
              className={`border rounded-xl p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2 ${
                editingId === r.id ? 'border-slate-900 bg-slate-50' : 'border-slate-200'
              }`}
            >
              <div>
                <div className="font-medium">{r.name} {r.enabled ? "" : "(כבוי)"}</div>
                <div className="text-xs text-slate-500">
                  {r.match_field === "merchant" ? "תיאור/בית עסק" : r.match_field === "category_raw" ? "קטגוריה מקורית" : r.match_field} {r.match_type} "{r.pattern}" → {r.category_name}
                  {r.source ? ` · מקור: ${formatSourceLabel(r.source)}` : ""}
                  {r.direction ? ` · סוג: ${r.direction}` : ""}
                </div>
              </div>
              <div className="flex gap-2">
                <button 
                  className="btn" 
                  onClick={() => startEdit(r)}
                >
                  ערוך
                </button>
                <button 
                  className="btn" 
                  onClick={() => toggle(r.id, r.enabled)}
                >
                  {r.enabled ? "כבה" : "הפעל"}
                </button>
                <button 
                  className="btn" 
                  onClick={() => del(r.id)}
                >
                  מחק
                </button>
              </div>
            </div>
          ))}
          {filteredRules.length === 0 && <div className="text-slate-500 text-sm">אין חוקים עדיין.</div>}
        </div>
      </div>
    </div>
  );
}
