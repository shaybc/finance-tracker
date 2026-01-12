import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../api.js";
import { formatDateDMY, formatILS, isoMonthStart, isoToday } from "../utils/format.js";
import { PieChart, LineChart } from "../components/Charts.jsx";

export default function Dashboard() {
  const navigate = useNavigate();
  const [from, setFrom] = useState(isoMonthStart());
  const [to, setTo] = useState(isoToday());
  const [rangePreset, setRangePreset] = useState("custom");
  const [summary, setSummary] = useState(null);
  const [byCat, setByCat] = useState([]);
  const [byTag, setByTag] = useState([]);
  const [pieMode, setPieMode] = useState("expense");
  const [drilldown, setDrilldown] = useState(null);
  const [pieExpanded, setPieExpanded] = useState(false);
  const [series, setSeries] = useState([]);
  const [anomalies, setAnomalies] = useState([]);

  useEffect(() => {
    let isMounted = true;
    const loadDefaultRange = async () => {
      try {
        const setting = await apiGet("/api/settings/dashboard-range");
        if (!isMounted) return;
        const preset = setting?.rangePreset || "custom";
        if (preset !== "custom") {
          setRangePreset(preset);
          const presetRange = getPresetRange(preset);
          if (presetRange) {
            setFrom(presetRange.from);
            setTo(presetRange.to);
          }
          return;
        }
      } catch (error) {
        console.error(error);
      }

      try {
        const r = await apiGet("/api/stats/date-range");
        if (!isMounted) return;
        if (r?.minDate && r?.maxDate) {
          setFrom(r.minDate);
          setTo(r.maxDate);
          setRangePreset("custom");
        }
      } catch (error) {
        console.error(error);
      }
    };

    loadDefaultRange();
    return () => {
      isMounted = false;
    };
  }, []);

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

  const toIsoDate = (date) => {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const getPresetRange = (value) => {
    if (value === "custom") {
      return null;
    }

    const today = new Date();
    const toIso = toIsoDate(today);
    const fromDate = new Date(today);

    if (value === "30") {
      fromDate.setDate(fromDate.getDate() - 29);
    } else if (value === "60") {
      fromDate.setDate(fromDate.getDate() - 59);
    } else if (value === "half-year") {
      fromDate.setMonth(fromDate.getMonth() - 6);
    } else if (value === "year") {
      fromDate.setFullYear(fromDate.getFullYear() - 1);
    }

    return { from: toIsoDate(fromDate), to: toIso };
  };

  const handlePresetChange = (event) => {
    const value = event.target.value;
    setRangePreset(value);

    const presetRange = getPresetRange(value);
    if (!presetRange) {
      return;
    }

    setFrom(presetRange.from);
    setTo(presetRange.to);
  };

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
            type="date"
            dir="ltr"
            value={from}
            onChange={(e) => {
              setRangePreset("custom");
              setFrom(e.target.value);
            }}
          />
        </div>
        <div>
          <div className="text-xs text-slate-500">עד תאריך</div>
          <input
            className="input"
            type="date"
            dir="ltr"
            value={to}
            onChange={(e) => {
              setRangePreset("custom");
              setTo(e.target.value);
            }}
          />
        </div>
        <div>
          <div className="text-xs text-slate-500">טווח ימים</div>
          <select
            className="input"
            value={rangePreset}
            onChange={handlePresetChange}
          >
            <option value="custom">בחירת טווח</option>
            <option value="30">30 ימים אחרונים</option>
            <option value="60">60 ימים אחרונים</option>
            <option value="half-year">חצי שנה אחרונה</option>
            <option value="year">שנה אחרונה</option>
          </select>
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

      {pieExpanded ? (
        <div className="fixed inset-0 z-50 bg-slate-50 p-4 overflow-auto">
          <div className="card p-4 h-full">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              {drilldown && (
                <button className="btn" onClick={() => setDrilldown(null)}>
                  חזרה
                </button>
              )}
              <div className="flex items-center gap-2">
                <select
                  className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
                  value={pieMode}
                  onChange={(event) => setPieMode(event.target.value)}
                >
                  <option value="expense">הוצאות לפי קטגוריה</option>
                  <option value="income">הכנסות לפי קטגוריה</option>
                  <option value="both">הכנסות והוצאות יחד</option>
                </select>
                <button
                  className="btn"
                  type="button"
                  onClick={() => setPieExpanded(false)}
                  aria-label="צמצום תצוגה"
                  title="צמצום תצוגה"
                >
                  ⤡
                </button>
              </div>
            </div>
            <div className="w-full max-w-4xl mx-auto">
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
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                {drilldown && (
                  <button className="btn" onClick={() => setDrilldown(null)}>
                    חזרה
                  </button>
                )}
                <div className="flex items-center gap-2">
                  <select
                    className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
                    value={pieMode}
                    onChange={(event) => setPieMode(event.target.value)}
                  >
                    <option value="expense">הוצאות לפי קטגוריה</option>
                    <option value="income">הכנסות לפי קטגוריה</option>
                    <option value="both">הכנסות והוצאות יחד</option>
                  </select>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setPieExpanded(true)}
                    aria-label="הרחבת תצוגה"
                    title="הרחבת תצוגה"
                  >
                    ⤢
                  </button>
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
              {anomalies.length === 0 && (
                <div className="text-slate-500 text-sm">אין חריגים בטווח הזה.</div>
              )}
            </div>
          </div>
        </>
      )}
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
