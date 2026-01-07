import React from "react";

export default function FiltersBar({ filters, setFilters, categories, sources }) {
  return (
    <div className="card p-4 mb-4">
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
        <div>
          <label className="text-xs text-slate-500">מתאריך</label>
          <input className="input w-full" type="date" value={filters.from || ""} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        </div>
        <div>
          <label className="text-xs text-slate-500">עד תאריך</label>
          <input className="input w-full" type="date" value={filters.to || ""} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </div>

        <div>
          <label className="text-xs text-slate-500">חיפוש</label>
          <input className="input w-full" placeholder="סופר פארם / UBER / ..." value={filters.q || ""} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        </div>

        <div>
          <label className="text-xs text-slate-500">מקור</label>
          <select className="select w-full" value={filters.source || ""} onChange={(e) => setFilters({ ...filters, source: e.target.value || null })}>
            <option value="">הכול</option>
            {sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>

        <div>
          <label className="text-xs text-slate-500">קטגוריה</label>
          <select className="select w-full" value={filters.categoryId || ""} onChange={(e) => setFilters({ ...filters, categoryId: e.target.value || null })}>
            <option value="">הכול</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ""}{c.name_he}</option>)}
          </select>
        </div>

        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={filters.uncategorized === "1"} onChange={(e) => setFilters({ ...filters, uncategorized: e.target.checked ? "1" : "0" })} />
            לא מסווג
          </label>
          <button className="btn" onClick={() => setFilters({ from: "", to: "", q: "", source: "", categoryId: "", uncategorized: "0" })}>איפוס</button>
        </div>
      </div>
    </div>
  );
}
