import React, { useEffect, useRef, useState } from "react";

export default function FiltersBar({ filters, setFilters, categories, sources, tags }) {
  const [fromDisplay, setFromDisplay] = useState("");
  const [toDisplay, setToDisplay] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);
  const tagsRef = useRef(null);

  useEffect(() => {
    setFromDisplay(formatDateDisplay(filters.from));
  }, [filters.from]);

  useEffect(() => {
    setToDisplay(formatDateDisplay(filters.to));
  }, [filters.to]);

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

  function formatDateDisplay(value) {
    if (!value) {
      return "";
    }
    const [year, month, day] = value.split("-");
    if (!year || !month || !day) {
      return value;
    }
    return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
  }

  function parseDateDisplay(value) {
    const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) {
      return null;
    }
    const [, day, month, year] = match;
    return `${year}-${month}-${day}`;
  }

  return (
    <div className="card p-4 mb-4">
      <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
        <div>
          <label className="text-xs text-slate-500">מתאריך</label>
          <input
            className="input w-full"
            type="text"
            dir="ltr"
            inputMode="numeric"
            placeholder="dd/mm/yyyy"
            value={fromDisplay}
            onChange={(e) => {
              const nextValue = e.target.value;
              setFromDisplay(nextValue);
              const parsed = parseDateDisplay(nextValue);
              if (parsed) {
                setFilters({ ...filters, from: parsed });
              }
            }}
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">עד תאריך</label>
          <input
            className="input w-full"
            type="text"
            dir="ltr"
            inputMode="numeric"
            placeholder="dd/mm/yyyy"
            value={toDisplay}
            onChange={(e) => {
              const nextValue = e.target.value;
              setToDisplay(nextValue);
              const parsed = parseDateDisplay(nextValue);
              if (parsed) {
                setFilters({ ...filters, to: parsed });
              }
            }}
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
              {filters.tagIds && filters.tagIds.length > 0
                ? `נבחרו ${filters.tagIds.length}`
                : "בחרו תגיות"}
            </span>
            <span className="text-slate-400">▾</span>
          </button>
          {tagsOpen && (
            <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg max-h-56 overflow-y-auto">
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
          <button className="btn" onClick={() => setFilters({ from: "", to: "", q: "", source: "", categoryId: "", tagIds: [], uncategorized: "0" })}>איפוס</button>
        </div>
      </div>
    </div>
  );
}
