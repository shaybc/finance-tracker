import React, { useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

const mainNav = [
  { to: "/", label: "סקירה" },
  { to: "/transactions", label: "תנועות" },
];

const managementNav = [
  { to: "/categories", label: "קטגוריות" },
  { to: "/tags", label: "תגים" },
  { to: "/rules", label: "חוקים" },
  { to: "/imports", label: "ייבוא" },
];

const oldNav = [
  { to: "/management/old/dashboard", label: "דשבורד ישן" },
  { to: "/management/old/reports", label: "דוחות ישנים" },
  { to: "/management/old/transactions", label: "תנועות ישן" },
];

export default function Layout({ children }) {
  const location = useLocation();
  const [managementOpen, setManagementOpen] = useState(false);
  const [oldOpen, setOldOpen] = useState(false);
  const isManagementActive =
    location.pathname.startsWith("/management") || location.pathname === "/settings";

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-slate-200">
        <div className="w-full 2xl:w-[82vw] max-w-none mx-auto px-4 py-4 flex items-center gap-4">
          <Link to="/" className="text-lg font-bold">מנהל הוצאות</Link>
          <nav className="flex gap-2 flex-wrap items-center">
            {mainNav.map((n) => (
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
            <div
              className="relative"
              onMouseEnter={() => setManagementOpen(true)}
              onMouseLeave={() => {
                setManagementOpen(false);
                setOldOpen(false);
              }}
            >
              <button
                type="button"
                className={
                  "px-3 py-2 rounded-xl text-sm border " +
                  (isManagementActive ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 hover:bg-slate-50")
                }
                onClick={() => setManagementOpen((open) => !open)}
                aria-haspopup="true"
                aria-expanded={managementOpen}
              >
                ניהול
              </button>
              {managementOpen && (
                <div className="absolute right-0 top-full z-[45] w-56 rounded-xl border border-slate-200 bg-white p-2 text-sm shadow-lg">
                  <NavLink
                    to="/settings"
                    className="block rounded-lg px-3 py-2 text-slate-700 hover:bg-slate-50"
                    onClick={() => setManagementOpen(false)}
                  >
                    הגדרות
                  </NavLink>
                  <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                    {managementNav.map((n) => (
                      <NavLink
                        key={n.to}
                        to={n.to}
                        className={({ isActive }) =>
                          "block rounded-lg px-3 py-2 " +
                          (isActive ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-50")
                        }
                        onClick={() => setManagementOpen(false)}
                      >
                        {n.label}
                      </NavLink>
                    ))}
                  </div>
                  <div className="mt-2 border-t border-slate-100 pt-2" onMouseEnter={() => setOldOpen(true)}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-right text-slate-700 hover:bg-slate-50"
                      onClick={() => setOldOpen((open) => !open)}
                      aria-haspopup="true"
                      aria-expanded={oldOpen}
                    >
                      <span>Old</span>
                      <span className="text-slate-400">{oldOpen ? "▴" : "▾"}</span>
                    </button>
                    {oldOpen && (
                      <div className="mt-1 space-y-1 border-r border-slate-100 pr-2">
                        {oldNav.map((n) => (
                          <NavLink
                            key={n.to}
                            to={n.to}
                            className={({ isActive }) =>
                              "block rounded-lg px-3 py-2 " +
                              (isActive ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-50")
                            }
                            onClick={() => {
                              setManagementOpen(false);
                              setOldOpen(false);
                            }}
                          >
                            {n.label}
                          </NavLink>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </nav>
        </div>
      </header>

      <main className="w-full 2xl:w-[82vw] max-w-none mx-auto p-4">
        {children}
      </main>

      <footer className="w-full 2xl:w-[82vw] max-w-none mx-auto p-4 text-xs text-slate-500">
        טיפ: העתק קבצי Excel ל־<code className="bg-slate-100 px-1 rounded">data/inbox</code> והמערכת תייבא אוטומטית.
      </footer>
    </div>
  );
}
