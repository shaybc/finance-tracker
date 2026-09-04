import React, { useEffect, useMemo, useState } from "react";
import { apiGet } from "../api.js";
import { formatDateDMY, formatILS, isoMonthStart, isoToday } from "../utils/format.js";
import { formatSourceLabel } from "../utils/source.js";

// New overview surface for balance, cashflow, and forecast readiness.
export default function Overview() {
  const [from, setFrom] = useState(isoMonthStart());
  const [to, setTo] = useState(isoToday());
  const [summary, setSummary] = useState({ expenses: 0, income: 0, net: 0, count: 0 });
  const [transactions, setTransactions] = useState([]);
  const [categories, setCategories] = useState([]);
  const [anomalies, setAnomalies] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function loadOverview() {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ from, to }).toString();
        const txQs = new URLSearchParams({
          from,
          to,
          page: "1",
          pageSize: "60",
          sort: "chronological_index_desc",
        }).toString();
        const [summaryRes, txRes, categoryRes, anomaliesRes] = await Promise.all([
          apiGet(`/api/stats/summary?${qs}`),
          apiGet(`/api/transactions?${txQs}`),
          apiGet(`/api/stats/by-category?${qs}&direction=expense`),
          apiGet(`/api/stats/anomalies?${qs}&minAbs=500`),
        ]);

        if (!isMounted) return;
        setSummary(summaryRes || { expenses: 0, income: 0, net: 0, count: 0 });
        setTransactions(txRes.rows || []);
        setCategories(categoryRes.rows || []);
        setAnomalies(anomaliesRes.rows || []);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadOverview().catch(console.error);
    return () => {
      isMounted = false;
    };
  }, [from, to]);

  const latestBalance = useMemo(() => {
    const row = transactions.find((transaction) => transaction.balance_amount != null);
    return Number(row?.balance_amount || 0);
  }, [transactions]);

  const forecastBalance = useMemo(() => {
    const today = new Date(`${to}T00:00:00`);
    const start = new Date(`${from}T00:00:00`);
    if (Number.isNaN(today.getTime()) || Number.isNaN(start.getTime())) {
      return latestBalance;
    }
    const elapsedDays = Math.max(1, Math.ceil((today - start) / 86400000) + 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const remainingDays = Math.max(0, Math.ceil((monthEnd - today) / 86400000));
    const dailyNet = Number(summary.net || 0) / elapsedDays;
    return latestBalance + dailyNet * remainingDays;
  }, [from, to, latestBalance, summary.net]);

  const balancePoints = useMemo(() => {
    return transactions
      .filter((transaction) => transaction.balance_amount != null)
      .slice(0, 16)
      .reverse()
      .map((transaction) => ({
        label: formatDateDMY(transaction.txn_date),
        value: Number(transaction.balance_amount || 0),
      }));
  }, [transactions]);

  const uncategorizedCount = transactions.filter((transaction) => !transaction.category_id).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-950">סקירה</h1>
          <p className="text-sm text-slate-500">יתרה, תזרים והערכה ראשונית לחודש הנוכחי</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-500">
            מתאריך
            <input className="input mt-1 block" type="date" dir="rtl" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="text-xs text-slate-500">
            עד תאריך
            <input className="input mt-1 block" type="date" dir="rtl" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Stat label="יתרה נוכחית" value={formatILS(latestBalance)} tone={latestBalance >= 0 ? "positive" : "negative"} detail="לפי התנועה האחרונה עם יתרה" />
        <Stat label="תחזית סוף חודש" value={formatILS(forecastBalance)} tone={forecastBalance >= 0 ? "positive" : "negative"} detail="הערכה לפי קצב נטו נוכחי" />
        <Stat label="הכנסות בטווח" value={formatILS(summary.income)} tone="positive" detail={`${Number(summary.count || 0).toLocaleString("he-IL")} תנועות`} />
        <Stat label="לא מסווגות בדף" value={uncategorizedCount.toLocaleString("he-IL")} detail="מתוך התנועות האחרונות שנטענו" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,0.8fr)]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-950">יתרה לאורך זמן</h2>
              <div className="text-xs text-slate-500">קו מלא: יתרות בפועל. קו מקווקו: הערכה ראשונית.</div>
            </div>
            {loading && <div className="text-xs text-slate-500">טוען...</div>}
          </div>
          <BalanceChart points={balancePoints} forecastValue={forecastBalance} />
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold text-slate-950">התראות תזרים</h2>
          <div className="mt-3 divide-y divide-slate-100">
            {anomalies.slice(0, 4).map((transaction) => (
              <div key={transaction.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <div className="font-medium text-slate-900">{transaction.merchant || transaction.description || "ללא תיאור"}</div>
                  <div className="text-xs text-slate-500">
                    {formatDateDMY(transaction.txn_date)} · {transaction.category_name || "לא מסווג"}
                  </div>
                </div>
                <div className={(Number(transaction.amount_signed || 0) < 0 ? "text-red-600" : "text-emerald-600") + " whitespace-nowrap font-semibold"} dir="ltr">
                  {formatILS(transaction.amount_signed)}
                </div>
              </div>
            ))}
            {anomalies.length === 0 && (
              <div className="py-3 text-sm text-slate-500">אין תנועות חריגות בטווח הזה.</div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold text-slate-950">התפלגות הוצאות</h2>
          <div className="mt-3 space-y-3">
            {categories.slice(0, 6).map((category) => (
              <CategoryBar key={`${category.category_id}-${category.category}`} category={category} max={categories[0]?.total || 1} />
            ))}
            {categories.length === 0 && <div className="text-sm text-slate-500">אין נתונים להצגה.</div>}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold text-slate-950">חשבונות ומקורות אחרונים</h2>
          <div className="mt-3 divide-y divide-slate-100">
            {transactions.slice(0, 5).map((transaction) => (
              <div key={transaction.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <div className="font-medium text-slate-900">{formatSourceLabel(transaction.source || "")}</div>
                  <div className="text-xs text-slate-500">{transaction.account_ref || transaction.merchant || transaction.description || "-"}</div>
                </div>
                <div className="font-semibold" dir="ltr">{formatILS(transaction.balance_amount ?? transaction.amount_signed)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, detail, tone = "neutral" }) {
  const toneClass = tone === "positive" ? "text-emerald-600" : tone === "negative" ? "text-red-600" : "text-slate-950";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`${toneClass} mt-2 text-2xl font-bold`} dir="ltr">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{detail}</div>
    </div>
  );
}

function BalanceChart({ points, forecastValue }) {
  const values = points.map((point) => point.value).concat([forecastValue]);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const width = 720;
  const height = 220;
  const xStep = points.length > 1 ? 560 / (points.length - 1) : 0;
  const y = (value) => 170 - ((value - min) / Math.max(1, max - min)) * 120;
  const pointPath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${70 + index * xStep} ${y(point.value)}`).join(" ");
  const lastX = points.length ? 70 + (points.length - 1) * xStep : 70;
  const lastY = points.length ? y(points[points.length - 1].value) : y(0);
  const forecastPath = `M ${lastX} ${lastY} L 680 ${y(forecastValue)}`;

  return (
    <svg className="h-64 w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="גרף יתרות">
      <line x1="60" y1="180" x2="690" y2="180" stroke="#cbd5e1" />
      <line x1="60" y1="35" x2="60" y2="180" stroke="#cbd5e1" />
      {[0, 1, 2, 3].map((tick) => {
        const tickY = 180 - tick * 40;
        return <line key={tick} x1="60" y1={tickY} x2="690" y2={tickY} stroke="#e2e8f0" />;
      })}
      {pointPath && <path d={pointPath} fill="none" stroke="#2563eb" strokeWidth="3" />}
      {points.map((point, index) => (
        <circle key={`${point.label}-${index}`} cx={70 + index * xStep} cy={y(point.value)} r="4" fill="#2563eb" />
      ))}
      <path d={forecastPath} fill="none" stroke="#7c3aed" strokeDasharray="8 6" strokeWidth="3" />
      <circle cx="680" cy={y(forecastValue)} r="5" fill="#7c3aed" />
      <text x="70" y="205" fill="#64748b" fontSize="12">{points[0]?.label || "תחילת טווח"}</text>
      <text x="610" y="205" fill="#64748b" fontSize="12">סוף חודש</text>
    </svg>
  );
}

function CategoryBar({ category, max }) {
  const total = Math.abs(Number(category.total || 0));
  const width = Math.min(100, Math.round((total / Math.max(1, Math.abs(Number(max || 1)))) * 100));
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)_110px] items-center gap-3 text-sm">
      <div className="truncate text-slate-700">{category.icon ? `${category.icon} ` : ""}{category.category}</div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-blue-600" style={{ width: `${width}%` }} />
      </div>
      <div className="text-left font-semibold text-slate-900" dir="ltr">{formatILS(total)}</div>
    </div>
  );
}
