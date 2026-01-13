import React, { useEffect, useRef, useState } from "react";

export default function FiltersBar({ filters, setFilters, categories, sources, tags }) {
  const [tagsOpen, setTagsOpen] = useState(false);
  const tagsRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (tagsRef.current && !tagsRef.current.contains(event.target)) {
        setTagsOpen(false);
      }
    }

    if (tagsOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [tagsOpen]);

  return (
    <div className="card p-4 mb-4">
      <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
        <div>
          <label className="text-xs text-slate-500">מתאריך</label>
          <input
            className="input w-full"
            type="date"
            dir="rtl"
            value={filters.from || ""}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">עד תאריך</label>
          <input
            className="input w-full"
            type="date"
            dir="rtl"
            value={filters.to || ""}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
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

        <div ref={tagsRef} className="relative">
          <label className="text-xs text-slate-500">תגים</label>
          <button
            type="button"
            className="select w-full flex items-center justify-between"
            onClick={() => setTagsOpen((open) => !open)}
            aria-expanded={tagsOpen}
          >
            <span className="truncate">
              {(() => {
                const tagCount = filters.tagIds ? filters.tagIds.length : 0;
                const hasUntagged = filters.untagged === "1";
                if (hasUntagged && tagCount === 0) {
                  return "ללא תיוג";
                }
                if (hasUntagged || tagCount > 0) {
                  return `נבחרו ${tagCount + (hasUntagged ? 1 : 0)}`;
                }
                return "בחרו תגיות";
              })()}
            </span>
            <span className="text-slate-400">▾</span>
          </button>
          {tagsOpen && (
            <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg max-h-56 overflow-y-auto">
              <label className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 border-b border-slate-100">
                <input
                  type="checkbox"
                  checked={filters.untagged === "1"}
                  onChange={(event) =>
                    setFilters({ ...filters, untagged: event.target.checked ? "1" : "0" })
                  }
                />
                <span>ללא תיוג</span>
              </label>
              {tags.map((tag) => {
                const tagId = String(tag.id);
                const checked = (filters.tagIds || []).includes(tagId);
                return (
                  <label
                    key={tag.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const current = new Set(filters.tagIds || []);
                        if (current.has(tagId)) {
                          current.delete(tagId);
                        } else {
                          current.add(tagId);
                        }
                        setFilters({ ...filters, tagIds: Array.from(current) });
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

        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={filters.uncategorized === "1"} onChange={(e) => setFilters({ ...filters, uncategorized: e.target.checked ? "1" : "0" })} />
            לא מסווג
          </label>
          <button className="btn" onClick={() => setFilters({ from: "", to: "", q: "", source: "", categoryId: "", tagIds: [], direction: "", untagged: "0", uncategorized: "0" })}>איפוס</button>
        </div>
      </div>
    </div>
  );
}
