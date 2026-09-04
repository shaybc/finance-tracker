import React, { useEffect, useMemo, useState } from "react"
import { apiGet } from "../api.js"
import { BarChart, LineChart, PieChart } from "../components/Charts.jsx"
import { formatILS, isoMonthStart, isoToday } from "../utils/format.js"
import { formatSourceLabel } from "../utils/source.js"
import {
  TRANSACTIONS_RANGE_OPTIONS,
  getTransactionsDateRange,
  resolveTransactionsRangeOption
} from "../utils/transactions.js"

const measureOptions = [
  { value: "expense", label: "הוצאות" },
  { value: "income", label: "הכנסות" },
  { value: "net", label: "נטו" },
  { value: "income_expense", label: "השוואת הכנסות והוצאות" }
]

const breakdownOptions = [
  { value: "category", label: "קטגוריות" },
  { value: "tag", label: "תגים" },
  { value: "month", label: "חודשים" }
]

const seriesOptions = [
  { value: "none", label: "ללא חלוקה נוספת" },
  { value: "category", label: "כל קטגוריה כסדרה נפרדת" },
  { value: "tag", label: "כל תג כסדרה נפרדת" }
]

const chartOptions = [
  { value: "bar", label: "עמודות" },
  { value: "pie", label: "עוגה" },
  { value: "line", label: "קו" }
]

export default function Reports() {
  const [from, setFrom] = useState(isoMonthStart())
  const [to, setTo] = useState(isoToday())
  const [rangeOption, setRangeOption] = useState("custom")
  const [allTransactionsRange, setAllTransactionsRange] = useState({ minDate: null, maxDate: null })
  const [measure, setMeasure] = useState("expense")
  const [breakdown, setBreakdown] = useState("category")
  const [series, setSeries] = useState("none")
  const [chartType, setChartType] = useState("bar")
  const [selectedCategoryIds, setSelectedCategoryIds] = useState([])
  const [selectedTagIds, setSelectedTagIds] = useState([])
  const [source, setSource] = useState("")
  const [includeExcludedFromCalculations, setIncludeExcludedFromCalculations] = useState(false)
  const [categories, setCategories] = useState([])
  const [tags, setTags] = useState([])
  const [sources, setSources] = useState([])
  const [report, setReport] = useState({ labels: [], datasets: [], rows: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [summarySort, setSummarySort] = useState({ key: "", direction: "asc" })

  useEffect(() => {
    let isMounted = true
    async function loadOptions() {
      const [categoryRes, tagRes, sourceRes, rangeRes] = await Promise.all([
        apiGet("/api/categories"),
        apiGet("/api/tags"),
        apiGet("/api/sources"),
        apiGet("/api/stats/date-range")
      ])
      if (!isMounted) return
      setCategories(categoryRes.items || [])
      setTags(tagRes.items || [])
      setSources(sourceRes.items || [])
      setAllTransactionsRange({
        minDate: rangeRes?.minDate || null,
        maxDate: rangeRes?.maxDate || null
      })
      if (rangeRes?.minDate && rangeRes?.maxDate) {
        setFrom(rangeRes.minDate)
        setTo(rangeRes.maxDate)
        setRangeOption("all")
      }
    }
    loadOptions().catch(console.error)
    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    let isMounted = true
    async function loadReport() {
      setLoading(true)
      setError("")
      try {
        const qs = new URLSearchParams({
          from,
          to,
          measure,
          breakdown,
          series,
          source,
          categoryIds: selectedCategoryIds.join(","),
          tagIds: selectedTagIds.join(","),
          includeExcludedFromCalculations: includeExcludedFromCalculations ? "1" : "0"
        }).toString()
        const nextReport = await apiGet("/api/reports/preview?" + qs)
        if (isMounted) {
          setReport(nextReport)
        }
      } catch (err) {
        console.error(err)
        if (isMounted) {
          setError("לא ניתן לטעון את הדוח כרגע")
          setReport({ labels: [], datasets: [], rows: [] })
        }
      } finally {
        if (isMounted) {
          setLoading(false)
        }
      }
    }
    loadReport()
    return () => {
      isMounted = false
    }
  }, [
    from,
    to,
    measure,
    breakdown,
    series,
    source,
    selectedCategoryIds.join(","),
    selectedTagIds.join(","),
    includeExcludedFromCalculations
  ])

  const pieData = useMemo(() => {
    if (measure === "income_expense") {
      return report.rows.flatMap((row) => [
        {
          label: formatRowLabel(row) + " · הכנסות",
          value: Number(row.income || 0),
          rawValue: Number(row.income || 0)
        },
        {
          label: formatRowLabel(row) + " · הוצאות",
          value: Number(row.expenses || 0),
          rawValue: Number(row.expenses || 0)
        }
      ]).filter((row) => row.value > 0)
    }
    return report.rows
      .map((row) => ({
        label: formatRowLabel(row),
        value: Math.abs(Number(row.total || 0)),
        rawValue: Number(row.total || 0)
      }))
      .filter((row) => row.value > 0)
  }, [measure, report.rows])

  const totals = useMemo(() => {
    return report.rows.reduce(
      (acc, row) => ({
        income: acc.income + Number(row.income || 0),
        expenses: acc.expenses + Number(row.expenses || 0),
        net: acc.net + Number(row.net || 0),
        count: acc.count + Number(row.count || 0)
      }),
      { income: 0, expenses: 0, net: 0, count: 0 }
    )
  }, [report.rows])

  const summaryRows = useMemo(() => {
    if (!summarySort.key) {
      return report.rows
    }
    const directionMultiplier = summarySort.direction === "asc" ? 1 : -1
    return [...report.rows].sort((left, right) => {
      if (summarySort.key === "label") {
        return directionMultiplier * formatRowLabel(left).localeCompare(formatRowLabel(right), "he")
      }
      const leftValue = Number(left[summarySort.key] || 0)
      const rightValue = Number(right[summarySort.key] || 0)
      if (leftValue === rightValue) {
        return formatRowLabel(left).localeCompare(formatRowLabel(right), "he")
      }
      return directionMultiplier * (leftValue - rightValue)
    })
  }, [report.rows, summarySort])

  function handleSummarySort(key) {
    setSummarySort((current) => {
      if (current.key === key) {
        return { key, direction: current.direction === "asc" ? "desc" : "asc" }
      }
      return { key, direction: "asc" }
    })
  }

  function applyRangeOption(value) {
    setRangeOption(value)
    if (value === "custom") {
      return
    }
    if (value === "all") {
      if (allTransactionsRange.minDate && allTransactionsRange.maxDate) {
        setFrom(allTransactionsRange.minDate)
        setTo(allTransactionsRange.maxDate)
      }
      return
    }
    const option = resolveTransactionsRangeOption(value)
    const range = getTransactionsDateRange(option)
    if (range) {
      setFrom(range.from)
      setTo(range.to)
    }
  }

  function handleManualFromChange(value) {
    setRangeOption("custom")
    setFrom(value)
  }

  function handleManualToChange(value) {
    setRangeOption("custom")
    setTo(value)
  }

  function handleMultiSelect(event, setter) {
    setter(Array.from(event.target.selectedOptions).map((option) => option.value))
  }

  const sourceOptions = [
    { value: "", label: "כל המקורות" },
    { value: "bank", label: formatSourceLabel("bank") },
    ...Array.from(new Set(sources.filter(Boolean)))
      .filter((value) => value !== "bank")
      .map((value) => ({ value, label: formatSourceLabel(value) }))
  ]

  const chartTitle =
    (measureOptions.find((option) => option.value === measure)?.label || "") +
    " לפי " +
    (breakdownOptions.find((option) => option.value === breakdown)?.label || "")

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col md:flex-row md:items-end gap-3">
            <Field label="מתאריך">
              <input className="input" type="date" dir="rtl" value={from} onChange={(e) => handleManualFromChange(e.target.value)} />
            </Field>
            <Field label="עד תאריך">
              <input className="input" type="date" dir="rtl" value={to} onChange={(e) => handleManualToChange(e.target.value)} />
            </Field>
            <Field label="היסטוריית תנועות">
              <select className="input" value={rangeOption} onChange={(e) => applyRangeOption(e.target.value)}>
                <option value="custom">טווח מותאם אישית</option>
                {TRANSACTIONS_RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="מדד">
              <select className="input" value={measure} onChange={(e) => setMeasure(e.target.value)}>
                {measureOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="חלוקה">
              <select className="input" value={breakdown} onChange={(e) => setBreakdown(e.target.value)}>
                {breakdownOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="תרשים">
              <select className="input" value={chartType} onChange={(e) => setChartType(e.target.value)}>
                {chartOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Field label="חלוקה נוספת">
              <select className="input" value={series} onChange={(e) => setSeries(e.target.value)}>
                {seriesOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="מקור">
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                {sourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="קטגוריות">
              <select className="input min-h-28" multiple value={selectedCategoryIds} onChange={(event) => handleMultiSelect(event, setSelectedCategoryIds)}>
                {categories.map((category) => (
                  <option key={category.id} value={String(category.id)}>{category.icon ? category.icon + " " : ""}{category.name_he}</option>
                ))}
              </select>
            </Field>
            <Field label="תגים">
              <select className="input min-h-28" multiple value={selectedTagIds} onChange={(event) => handleMultiSelect(event, setSelectedTagIds)}>
                {tags.map((tag) => (
                  <option key={tag.id} value={String(tag.id)}>{tag.icon ? tag.icon + " " : ""}{tag.name_he}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeExcludedFromCalculations} onChange={(e) => setIncludeExcludedFromCalculations(e.target.checked)} />
              <span>כלול תנועות שלא נכללות בחישובים</span>
            </label>
            <button className="btn" type="button" onClick={() => {
              setSelectedCategoryIds([])
              setSelectedTagIds([])
              setSource("")
            }}>
              נקה סינונים
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="הכנסות" value={formatILS(totals.income)} />
        <Stat label="הוצאות" value={formatILS(totals.expenses)} />
        <Stat label="נטו" value={formatILS(totals.net)} />
        <Stat label="תנועות" value={totals.count.toLocaleString("he-IL")} />
      </div>

      <div className="card p-4">
        <div className="min-h-96">
          {loading ? (
            <div className="text-sm text-slate-500">טוען דוח...</div>
          ) : error ? (
            <div className="text-sm text-red-600">{error}</div>
          ) : report.rows.length === 0 ? (
            <div className="text-sm text-slate-500">אין נתונים להצגה בטווח שנבחר.</div>
          ) : chartType === "pie" ? (
            <PieChart title={chartTitle} data={pieData.slice(0, 24)} />
          ) : chartType === "line" ? (
            <LineChart title={chartTitle} labels={report.labels} datasets={report.datasets} />
          ) : (
            <BarChart title={chartTitle} labels={report.labels} datasets={report.datasets} />
          )}
        </div>
      </div>

      <div className="card p-4">
        <div className="font-semibold mb-3">טבלת סיכום</div>
        <div className="overflow-auto">
          <table className="table">
            <thead>
              <tr className="border-b border-slate-200 text-right">
                <SortableHeader label="שם" sortKey="label" sortConfig={summarySort} onSort={handleSummarySort} />
                <SortableHeader label="הכנסות" sortKey="income" sortConfig={summarySort} onSort={handleSummarySort} />
                <SortableHeader label="הוצאות" sortKey="expenses" sortConfig={summarySort} onSort={handleSummarySort} />
                <SortableHeader label="נטו" sortKey="net" sortConfig={summarySort} onSort={handleSummarySort} />
                <SortableHeader label="תנועות" sortKey="count" sortConfig={summarySort} onSort={handleSummarySort} />
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => (
                <tr key={row.label + "-" + (row.seriesLabel || "") + "-" + (row.filterValue || "")} className="border-b border-slate-100">
                  <td className="py-2 px-2 font-medium">{formatRowLabel(row)}</td>
                  <td className="py-2 px-2 tabular-nums" dir="ltr">{formatILS(row.income)}</td>
                  <td className="py-2 px-2 tabular-nums" dir="ltr">{formatILS(row.expenses)}</td>
                  <td className="py-2 px-2 tabular-nums" dir="ltr">{formatILS(row.net)}</td>
                  <td className="py-2 px-2">{Number(row.count || 0).toLocaleString("he-IL")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function formatRowLabel(row) {
  return row.seriesLabel ? row.label + " · " + row.seriesLabel : row.label
}

function SortableHeader({ label, sortKey, sortConfig, onSort }) {
  const isActive = sortConfig.key === sortKey
  const indicator = isActive ? (sortConfig.direction === "asc" ? " ↑" : " ↓") : ""
  return (
    <th className="py-2 px-2">
      <button
        type="button"
        className="inline-flex items-center gap-1 font-semibold hover:text-slate-900"
        onClick={() => onSort(sortKey)}
        aria-label={"מיון לפי " + label}
      >
        <span>{label}</span>
        <span className="w-4 text-slate-500">{indicator}</span>
      </button>
    </th>
  )
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-slate-500">{label}</span>
      {children}
    </label>
  )
}

function Stat({ label, value }) {
  return (
    <div className="card p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-bold">{value}</div>
    </div>
  )
}
