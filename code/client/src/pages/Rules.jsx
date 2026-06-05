import React, { useEffect, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost, apiDelete, apiPost as post } from "../api.js";
import toast from "react-hot-toast";
import { formatSourceLabel } from "../utils/source.js";

export default function Rules() {
  const [rules, setRules] = useState([]);
  const [cats, setCats] = useState([]);
  const [tags, setTags] = useState([]);
  const [sources, setSources] = useState([]);
  const [isApplying, setIsApplying] = useState(false);
  const [applyingRuleId, setApplyingRuleId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedMenuOpen, setAdvancedMenuOpen] = useState(false);
  const [applyMenuOpen, setApplyMenuOpen] = useState(false);
  const tagsRef = useRef(null);
  const advancedMenuRef = useRef(null);
  const applyMenuRef = useRef(null);

  const [form, setForm] = useState({
    name: "",
    match_field: "merchant",
    match_type: "contains",
    pattern: "",
    source: "",
    direction: "",
    category_id: "",
    tag_ids: [],
    amount_min: "",
    amount_max: "",
    run_on_categorized: false,
  });

  async function load() {
    const r = await apiGet("/api/rules");
    const c = await apiGet("/api/categories");
    const t = await apiGet("/api/tags");
    const s = await apiGet("/api/sources");
    setRules(r.items || []);
    setCats(c.items || []);
    setTags(t.items || []);
    setSources(s.items || []);
  }

  useEffect(() => { load().catch(console.error); }, []);

  // Listen for reload events from other components
  useEffect(() => {
    const handleReload = () => load().catch(console.error);
    window.addEventListener('reload-rules', handleReload);
    return () => window.removeEventListener('reload-rules', handleReload);
  }, []);

  useEffect(() => {
    function handleClickOutside(event) {
      if (tagsRef.current && !tagsRef.current.contains(event.target)) {
        setTagsOpen(false);
      }
      if (advancedMenuRef.current && !advancedMenuRef.current.contains(event.target)) {
        setAdvancedMenuOpen(false);
      }
      if (applyMenuRef.current && !applyMenuRef.current.contains(event.target)) {
        setApplyMenuOpen(false);
      }
    }

    if (tagsOpen || advancedMenuOpen || applyMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [tagsOpen, advancedMenuOpen, applyMenuOpen]);

  function resolveAmountRange(rule) {
    const min = rule.amount_min;
    const max = rule.amount_max;
    if (min == null && max == null) return "";
    const formatAmount = (value) => Number(value).toLocaleString("he-IL");
    if (min != null && max != null) {
      return ` · סכום: ${formatAmount(min)}-${formatAmount(max)}`;
    }
    if (min != null) {
      return ` · סכום: מ-${formatAmount(min)}`;
    }
    return ` · סכום: עד ${formatAmount(max)}`;
  }

  function toNumberOrNull(value) {
    if (value === "" || value == null) return null;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function resolveTagNames(tagIds) {
    const lookup = new Map(tags.map((tag) => [tag.id, tag.name_he]));
    return tagIds.map((id) => lookup.get(id)).filter(Boolean);
  }

  const filteredRules = rules.filter((rule) => {
    if (!search.trim()) return true;
    const query = search.trim().toLowerCase();
    return [
      rule.pattern,
      rule.name,
      rule.category_name,
      resolveTagNames(rule.tag_ids || []).join(" "),
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
      category_id: form.category_id ? Number(form.category_id) : null,
      tag_ids: form.tag_ids,
      amount_min: toNumberOrNull(form.amount_min),
      amount_max: toNumberOrNull(form.amount_max),
      run_on_categorized: form.run_on_categorized,
    });
    setForm({ 
      name: "", 
      match_field: "merchant",
      match_type: "contains",
      pattern: "", 
      source: "",
      direction: "",
      category_id: "",
      tag_ids: [],
      amount_min: "",
      amount_max: "",
      run_on_categorized: false,
    });
    setAdvancedOpen(false);
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
      category_id: form.category_id ? Number(form.category_id) : null,
      tag_ids: form.tag_ids,
      amount_min: toNumberOrNull(form.amount_min),
      amount_max: toNumberOrNull(form.amount_max),
      run_on_categorized: form.run_on_categorized,
    });
    setForm({ 
      name: "", 
      match_field: "merchant",
      match_type: "contains",
      pattern: "", 
      source: "",
      direction: "",
      category_id: "",
      tag_ids: [],
      amount_min: "",
      amount_max: "",
      run_on_categorized: false,
    });
    setEditingId(null);
    setAdvancedOpen(false);
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
      category_id: rule.category_id ? String(rule.category_id) : "",
      tag_ids: rule.tag_ids || [],
      amount_min: rule.amount_min != null ? String(rule.amount_min) : "",
      amount_max: rule.amount_max != null ? String(rule.amount_max) : "",
      run_on_categorized: Boolean(rule.run_on_categorized),
    });
    setAdvancedOpen(rule.amount_min != null || rule.amount_max != null);
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
      category_id: "",
      tag_ids: [],
      amount_min: "",
      amount_max: "",
      run_on_categorized: false,
    });
    setAdvancedOpen(false);
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

  async function applyAll(scope = "uncategorized") {
    setIsApplying(true);
    try {
      const res = await post("/api/rules/apply", { scope });
      const data = res.data ?? res;
      if (scope === "categorized") {
        toast.success(`עודכנו ${data.updated_total ?? data.updated} מתוך ${data.scanned} תנועות מסווגות`);
      } else if (scope === "cancel_categorized") {
        toast.success(`בוטלו ${data.cleared ?? 0} תנועות מסווגות`);
      } else {
        toast.success(`סווגו ${data.updated} מתוך ${data.scanned} תנועות`);
      }
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

  async function applyRule(ruleId) {
    setApplyingRuleId(ruleId);
    try {
      const res = await post(`/api/rules/${ruleId}/apply`, {});
      const data = res.data ?? res;
      toast.success(`החוק הופעל: סווגו ${data.updated} מתוך ${data.scanned} תנועות`);
      await Promise.all([
        reloadTransactions(),
        reloadStats(),
        load()
      ]);
    } catch (err) {
      console.error("applyRule failed:", err);
      toast.error("שגיאה בהפעלת החוק");
    } finally {
      setApplyingRuleId(null);
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
            {editingId ? "עריכת חוק" : "חוקים לאוטומציה של קטגוריות ותגים"}
          </div>
          <div className="flex items-center gap-2">
            <div ref={applyMenuRef} className="relative inline-flex">
              <button
                type="button"
                className="px-3 py-2 bg-slate-900 text-white rounded-r-xl hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => setApplyMenuOpen((open) => !open)}
                aria-expanded={applyMenuOpen}
                aria-haspopup="true"
                disabled={isApplying}
              >
                ▾
              </button>
              {applyMenuOpen && (
                <div className="absolute right-0 mt-12 w-64 rounded-lg border border-slate-200 bg-white shadow-lg z-20">
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-right text-sm hover:bg-slate-50"
                    onClick={() => {
                      setApplyMenuOpen(false);
                      applyAll("categorized");
                    }}
                    disabled={isApplying}
                  >
                    הפעל חוקים על מסווגים
                  </button>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-right text-sm hover:bg-slate-50"
                    onClick={() => {
                      setApplyMenuOpen(false);
                      applyAll("cancel_categorized");
                    }}
                    disabled={isApplying}
                  >
                    בטל חוקים על מסווגים
                  </button>
                </div>
              )}
              <button 
                onClick={() => applyAll("uncategorized")} 
                disabled={isApplying} 
                className="px-4 py-2 bg-slate-900 text-white rounded-l-xl hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isApplying && (<span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />)}
                הפעל חוקים על לא-מסווגים
              </button>
            </div>
            <div ref={advancedMenuRef} className="relative">
              <button
                type="button"
                className="h-10 w-10 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50"
                onClick={() => setAdvancedMenuOpen((open) => !open)}
                aria-label="אפשרויות מתקדמות"
              >
                ⋯
              </button>
              {advancedMenuOpen && (
                <div className="absolute right-0 mt-2 w-32 rounded-lg border border-slate-200 bg-white shadow-lg z-20">
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-right text-sm hover:bg-slate-50"
                    onClick={() => {
                      setAdvancedOpen((open) => !open);
                      setAdvancedMenuOpen(false);
                    }}
                  >
                    {advancedOpen ? "פשוט" : "מתקדם"}
                  </button>
                </div>
              )}
            </div>
          </div>
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
            <option value="category_raw">תיאור חברת אשראי</option>
          </select>

          <div className="relative group w-full">
            <select 
              className="select w-full" 
              value={form.match_type} 
              onChange={(e) => setForm({ ...form, match_type: e.target.value })}
            >
              <option value="contains">מכיל</option>
              <option value="equals">שווה</option>
              <option value="regex">Regex</option>
            </select>
            <div className="pointer-events-none absolute top-full right-0 mt-2 w-72 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600 shadow-lg opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 text-right z-50">
              <div className="font-semibold text-slate-700 mb-1">דוגמאות Regex</div>
              <p className="mb-2">
                כדי להשתמש ב-RegEx בחרו באפשרות <span className="font-semibold">Regex</span> מהרשימה.
              </p>
              <div className="space-y-2">
                <p>
                  מילים שמכילות מספר:
                  <span className="font-mono block text-slate-800">\\b\\w*\\d\\w*\\b</span>
                  (לדוגמה: "דלק123").
                </p>
                <p>
                  התאמה לאחד משני מילים:
                  <span className="font-mono block text-slate-800">(מכולת|בית)</span>
                </p>
              </div>
            </div>
          </div>

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
            {sources.some((value) => value?.startsWith("כ.אשראי")) && (
              <option value="כ.אשראי">{formatSourceLabel("כ.אשראי")}</option>
            )}
            {Array.from(new Set(sources.filter(Boolean)))
              .filter((value) => value !== "bank" && value !== "כ.אשראי")
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

          <div ref={tagsRef} className="relative md:col-span-1">
            <button
              type="button"
              className="select w-full flex items-center justify-between"
              onClick={() => setTagsOpen((open) => !open)}
              aria-expanded={tagsOpen}
            >
              <span className="truncate">
                {form.tag_ids.length > 0 ? `נבחרו ${form.tag_ids.length}` : "בחרו תגיות"}
              </span>
              <span className="text-slate-400">▾</span>
            </button>
            {tagsOpen && (
              <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg max-h-56 overflow-y-auto">
                {tags.map((tag) => {
                  const checked = form.tag_ids.includes(tag.id);
                  return (
                    <label
                      key={tag.id}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(form.tag_ids);
                          if (next.has(tag.id)) {
                            next.delete(tag.id);
                          } else {
                            next.add(tag.id);
                          }
                          setForm({ ...form, tag_ids: Array.from(next) });
                        }}
                      />
                      <span>{tag.icon ? `${tag.icon} ` : ""}{tag.name_he}</span>
                    </label>
                  );
                })}
                {tags.length === 0 && (
                  <div className="px-3 py-2 text-sm text-slate-500">אין תגים</div>
                )}
              </div>
            )}
          </div>

          <div className="relative group md:col-span-1 flex items-center">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.run_on_categorized}
                onChange={(e) => setForm({ ...form, run_on_categorized: e.target.checked })}
              />
              <span>גם למקוטלגות</span>
            </label>
            <div className="pointer-events-none absolute top-full right-0 mt-2 w-96 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600 shadow-lg opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 text-right z-50">
              הרץ את החוק גם לטרנזאקציות שכבר קולטלגו ע&quot;י חוקים אחרים, המשמעות היא שהחוק
              ירוץ תמיד על כל הטרנזאקציות ויפעל על אלו שתואמות את התנאים ללא קשר אם הן כבר
              שייכות לקטגוריה כזו או אחרת. חוקים שהצ&apos;קבוקס הזה מסומן להם ירוצו אחרונים לאחר
              שכל החוקים הרגילים רצו.
            </div>
          </div>

          {advancedOpen && (
            <>
              <input
                className="input md:col-span-2"
                type="number"
                min="0"
                placeholder="סכום מינימלי"
                value={form.amount_min}
                onChange={(e) => setForm({ ...form, amount_min: e.target.value })}
              />
              <input
                className="input md:col-span-2"
                type="number"
                min="0"
                placeholder="סכום מקסימלי"
                value={form.amount_max}
                onChange={(e) => setForm({ ...form, amount_max: e.target.value })}
              />
              <div className="hidden md:block md:col-span-2" />
            </>
          )}

          {editingId ? (
            <>
              <button 
                className="btn md:col-span-3" 
                disabled={!form.name || !form.pattern || (!form.category_id && form.tag_ids.length === 0)} 
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
              disabled={!form.name || !form.pattern || (!form.category_id && form.tag_ids.length === 0)} 
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
            placeholder="חיפוש לפי שם, תבנית, קטגוריה או תגים"
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
                <div className="font-medium">
                  {r.name} <span className="text-blue-600">({r.applied_count ?? 0})</span> {r.enabled ? "" : "(כבוי)"}
                </div>
                <div className="text-xs text-slate-500">
                  {r.match_field === "merchant" ? "תיאור/בית עסק" : r.match_field === "category_raw" ? "תיאור חברת אשראי" : r.match_field} {r.match_type} "{r.pattern}" → {r.category_name || "ללא קטגוריה"}
                  {r.tag_ids && r.tag_ids.length > 0 ? ` · תגים: ${resolveTagNames(r.tag_ids).join(", ")}` : ""}
                  {r.source ? ` · מקור: ${formatSourceLabel(r.source)}` : ""}
                  {r.direction ? ` · סוג: ${r.direction}` : ""}
                  {resolveAmountRange(r)}
                  {r.run_on_categorized ? " · גם למקוטלגות" : ""}
                  {` · הופעל על ${r.applied_count ?? 0} תנועות`}
                </div>
              </div>
              <div className="flex gap-2 flex-nowrap items-start self-start md:self-start min-w-[260px]">
                <button 
                  className="btn" 
                  onClick={() => startEdit(r)}
                >
                  ערוך
                </button>
                <button
                  className="btn whitespace-nowrap"
                  onClick={() => applyRule(r.id)}
                  disabled={applyingRuleId === r.id}
                >
                  {applyingRuleId === r.id ? "מריץ..." : "הרץ חוק"}
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
