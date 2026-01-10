import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../api.js";
import { formatDateDMY, formatILS, isoMonthStart, isoToday, parseDateDMY } from "../utils/format.js";
import { PieChart, LineChart } from "../components/Charts.jsx";

export default function Dashboard() {
  const navigate = useNavigate();
  const [from, setFrom] = useState(isoMonthStart());
  const [to, setTo] = useState(isoToday());
  const [fromInput, setFromInput] = useState(() => formatDateDMY(isoMonthStart()));
  const [toInput, setToInput] = useState(() => formatDateDMY(isoToday()));
  const [summary, setSummary] = useState(null);
  const [byCat, setByCat] = useState([]);
  const [byTag, setByTag] = useState([]);
  const [pieMode, setPieMode] = useState("expense");
  const [drilldown, setDrilldown] = useState(null);
  const [series, setSeries] = useState([]);
  const [anomalies, setAnomalies] = useState([]);

  // If DB has data outside the current month, default UI range to DB min/max
  useEffect(() => {
    apiGet("/api/stats/date-range")
      .then((r) => {
        if (r?.minDate && r?.maxDate) {
          setFrom(r.minDate);
          setTo(r.maxDate);
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    setFromInput(formatDateDMY(from));
  }, [from]);

  useEffect(() => {
    setToInput(formatDateDMY(to));
  }, [to]);

  async function refresh() {
    const qs = new URLSearchParams({ from, to }).toString();
    const s = await apiGet(`/api/stats/summary?${qs}`);
    const directionParam = pieMode === "both" ? "all" : pieMode;
    const c = await apiGet(`/api/stats/by-category?${qs}&direction=${directionParam}`);
    const t = await apiGet(`/api/stats/timeseries?${qs}&group=day`);
    const a = await apiGet(`/api/stats/anomalies?${qs}&minAbs=500`);

    setSummary(s);
    setByCat(c.rows || []);
    setSeries(t.rows || []);
    setAnomalies(a.rows || []);
  }

  useEffect(() => {
    refresh().catch(console.error);
  }, [from, to, pieMode]);

  const pieData = useMemo(() => {
    return byCat.map((r) => ({
      label: `${r.icon} ${r.category}`,
      value: Math.abs(Number(r.total || 0)),
      rawValue: Number(r.total || 0),
      categoryId: r.category_id,
      categoryLabel: r.category,
    }));
  }, [byCat]);

  const tagPieData = useMemo(() => {
    return byTag.map((r) => ({
      label: `${r.icon} ${r.tag}`,
      value: Math.abs(Number(r.total || 0)),
      rawValue: Number(r.total || 0),
    }));
  }, [byTag]);

  useEffect(() => {
    if (!drilldown) {
      setByTag([]);
      return;
    }

    const directionParam = pieMode === "both" ? "all" : pieMode;
    const qs = new URLSearchParams({ from, to, direction: directionParam });
    if (drilldown.categoryId) {
      qs.set("categoryId", drilldown.categoryId);
    } else {
      qs.set("uncategorized", "1");
    }
    apiGet(`/api/stats/by-tag?${qs.toString()}`)
      .then((r) => setByTag(r.rows || []))
      .catch(console.error);
  }, [drilldown, from, to, pieMode]);

  useEffect(() => {
    setDrilldown(null);
    setByTag([]);
  }, [pieMode]);

  const lineData = useMemo(() => {
    return series.map((r) => ({ label: r.k, value: Number(r.total || 0) }));
  }, [series]);

  const handleSliceTransactions = (slice) => {
    const qs = new URLSearchParams({ from, to });
    if (slice?.categoryId) {
      qs.set("categoryId", slice.categoryId);
    } else {
      qs.set("uncategorized", "1");
    }
    qs.delete("direction");
    navigate(`/transactions?${qs.toString()}`);
  };

  const pieTitle = drilldown
    ? pieMode === "income"
      ? `פירוט הכנסות לפי תגיות · ${drilldown.categoryLabel}`
      : pieMode === "both"
        ? `פירוט הכנסות והוצאות לפי תגיות · ${drilldown.categoryLabel}`
        : `פירוט הוצאות לפי תגיות · ${drilldown.categoryLabel}`
    : pieMode === "income"
      ? "חלוקת הכנסות לפי קטגוריה"
      : pieMode === "both"
        ? "חלוקת הכנסות והוצאות לפי קטגוריה"
        : "חלוקת הוצאות לפי קטגוריה";

  return (
    <div className="space-y-4">
      <div className="card p-4 flex flex-col md:flex-row gap-3 md:items-end">
        <div>
          <div className="text-xs text-slate-500">מתאריך</div>
          <input
            className="input"
            inputMode="numeric"
            placeholder="dd/mm/yyyy"
            value={fromInput}
            onChange={(e) => {
              const nextValue = e.target.value;
              setFromInput(nextValue);
              const parsed = parseDateDMY(nextValue);
              if (parsed) {
                setFrom(parsed);
              }
            }}
          />
        </div>
        <div>
          <div className="text-xs text-slate-500">עד תאריך</div>
          <input
            className="input"
            inputMode="numeric"
            placeholder="dd/mm/yyyy"
            value={toInput}
            onChange={(e) => {
              const nextValue = e.target.value;
              setToInput(nextValue);
              const parsed = parseDateDMY(nextValue);
              if (parsed) {
                setTo(parsed);
              }
            }}
          />
        </div>
        <button className="btn" onClick={refresh}>רענן</button>

        <div className="flex-1" />
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat label="הוצאות" value={formatILS(summary.expenses)} />
            <Stat label="הכנסות" value={formatILS(summary.income)} />
            <Stat label="נטו" value={formatILS(summary.net)} />
            <Stat label="מס' תנועות" value={Number(summary.count || 0).toLocaleString("he-IL")} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            {drilldown && (
              <button className="btn" onClick={() => setDrilldown(null)}>
                חזרה
              </button>
            )}
            <div className="flex items-center">
              <select
                className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
                value={pieMode}
                onChange={(event) => setPieMode(event.target.value)}
              >
                <option value="expense">הוצאות לפי קטגוריה</option>
                <option value="income">הכנסות לפי קטגוריה</option>
                <option value="both">הכנסות והוצאות יחד</option>
              </select>
            </div>
          </div>
          <PieChart
            title={pieTitle}
            data={(drilldown ? tagPieData : pieData).slice(0, 12)}
            onSliceDetails={
              drilldown
                ? undefined
                : (slice) =>
                    setDrilldown({
                      categoryId: slice.categoryId,
                      categoryLabel: slice.categoryLabel,
                    })
            }
            onSliceTransactions={drilldown ? undefined : handleSliceTransactions}
          />
        </div>
        <div className="card p-4">
          <LineChart title="נטו יומי" data={lineData} />
        </div>
      </div>

      <div className="card p-4">
        <div className="font-semibold mb-3">הוצאות/תנועות חריגות (&gt;= 500 ₪)</div>
        <div className="space-y-2">
          {anomalies.slice(0, 10).map((a) => (
            <div key={a.id} className="flex items-center justify-between border border-slate-200 rounded-xl p-3">
              <div>
                <div className="font-medium">{a.merchant || a.description || "—"}</div>
                <div className="text-xs text-slate-500">
                  {formatDateDMY(a.txn_date)} ·{" "}
                  {a.category_name ? `${a.category_icon || ""} ${a.category_name}` : "לא מסווג"}
                </div>
              </div>
              <div className="font-bold">{formatILS(a.amount_signed)}</div>
            </div>
          ))}
          {anomalies.length === 0 && <div className="text-slate-500 text-sm">אין חריגים בטווח הזה.</div>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="border border-slate-200 rounded-xl p-3 bg-white">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-bold">{value}</div>
    </div>
  );
}
