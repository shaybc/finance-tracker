import React from "react";
import { Link, NavLink } from "react-router-dom";

const nav = [
  { to: "/", label: "דשבורד" },
  { to: "/transactions", label: "תנועות" },
  { to: "/categories", label: "קטגוריות" },
  { to: "/tags", label: "תגים" },
  { to: "/rules", label: "חוקים" },
  { to: "/imports", label: "ייבוא" },
];

export default function Layout({ children }) {
  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
          <Link to="/" className="text-lg font-bold">מנהל הוצאות</Link>
          <nav className="flex gap-2 flex-wrap">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  "px-3 py-2 rounded-xl text-sm border " +
                  (isActive ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 hover:bg-slate-50")
                }
              >
                {n.label}
              </NavLink>
            ))}
            <NavLink
              to="/settings"
              aria-label="הגדרות"
              className={({ isActive }) =>
                "px-3 py-2 rounded-xl text-sm border " +
                (isActive ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 hover:bg-slate-50")
              }
            >
              ⚙️
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4">
        {children}
      </main>

      <footer className="max-w-6xl mx-auto p-4 text-xs text-slate-500">
        טיפ: העתק קבצי Excel ל־<code className="bg-slate-100 px-1 rounded">data/inbox</code> והמערכת תייבא אוטומטית.
      </footer>
    </div>
  );
}
