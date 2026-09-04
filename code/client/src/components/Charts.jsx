import React, { useEffect, useRef } from "react";
import Chart from "chart.js/auto";
const chartColors = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#ca8a04",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#4f46e5",
  "#65a30d",
  "#ea580c"
]

function normalizeDatasets({ data, datasets, title }) {
  if (datasets && datasets.length > 0) {
    return datasets.map((dataset, index) => ({
      ...dataset,
      borderColor: dataset.borderColor || chartColors[index % chartColors.length],
      backgroundColor: dataset.backgroundColor || chartColors[index % chartColors.length] + "66",
      tension: dataset.tension ?? 0.25
    }))
  }

  return [
    {
      label: title || "סכום",
      data: (data || []).map((x) => x.value),
      borderColor: chartColors[0],
      backgroundColor: chartColors[0] + "66",
      tension: 0.25
    }
  ]
}

export function PieChart({
  title,
  data,
  onSliceDetails,
  detailsLabel = "פרטים",
  onSliceTransactions,
  transactionsLabel = "הצג תנועות",
}) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);
  const tooltipTitleRef = useRef(null);
  const tooltipValueRef = useRef(null);
  const tooltipButtonRef = useRef(null);
  const tooltipTransactionsButtonRef = useRef(null);
  const dataRef = useRef(data);
  const onSliceDetailsRef = useRef(onSliceDetails);
  const onSliceTransactionsRef = useRef(onSliceTransactions);
  const tooltipHoverRef = useRef(false);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    onSliceDetailsRef.current = onSliceDetails;
  }, [onSliceDetails]);

  useEffect(() => {
    onSliceTransactionsRef.current = onSliceTransactions;
  }, [onSliceTransactions]);

  useEffect(() => {
    const tooltipEl = tooltipRef.current;
    if (!tooltipEl) return;

    const handleEnter = () => {
      tooltipHoverRef.current = true;
    };
    const handleLeave = () => {
      tooltipHoverRef.current = false;
      tooltipEl.style.opacity = 0;
      tooltipEl.style.pointerEvents = "none";
    };

    tooltipEl.addEventListener("mouseenter", handleEnter);
    tooltipEl.addEventListener("mouseleave", handleLeave);

    return () => {
      tooltipEl.removeEventListener("mouseenter", handleEnter);
      tooltipEl.removeEventListener("mouseleave", handleLeave);
    };
  }, []);

  useEffect(() => {
    const button = tooltipButtonRef.current;
    if (!button) return;

    const handleClick = (event) => {
      event.stopPropagation();
      const index = Number(tooltipRef.current?.dataset.index);
      if (Number.isNaN(index)) return;
      const slice = dataRef.current[index];
      if (slice && onSliceDetailsRef.current) {
        onSliceDetailsRef.current(slice);
      }
    };

    button.addEventListener("click", handleClick);
    return () => {
      button.removeEventListener("click", handleClick);
    };
  }, []);

  useEffect(() => {
    const button = tooltipTransactionsButtonRef.current;
    if (!button) return;

    const handleClick = (event) => {
      event.stopPropagation();
      const index = Number(tooltipRef.current?.dataset.index);
      if (Number.isNaN(index)) return;
      const slice = dataRef.current[index];
      if (slice && onSliceTransactionsRef.current) {
        onSliceTransactionsRef.current(slice);
      }
    };

    button.addEventListener("click", handleClick);
    return () => {
      button.removeEventListener("click", handleClick);
    };
  }, []);

  useEffect(() => {
    if (!ref.current) return;
    const ctx = ref.current.getContext("2d");

    if (chartRef.current) chartRef.current.destroy();

    chartRef.current = new Chart(ctx, {
      type: "pie",
      data: {
        labels: data.map((x) => x.label),
        datasets: [{ data: data.map((x) => x.value) }],
      },
      options: {
        plugins: {
          legend: { position: "bottom" },
          title: { display: !!title, text: title },
          tooltip: {
            enabled: false,
            external: ({ chart, tooltip }) => {
              const tooltipEl = tooltipRef.current;
              if (!tooltipEl) return;

              if (tooltip.opacity === 0) {
                if (!tooltipHoverRef.current) {
                  tooltipEl.style.opacity = 0;
                  tooltipEl.style.pointerEvents = "none";
                }
                return;
              }

              const dataPoint = tooltip.dataPoints?.[0];
              const label = dataPoint?.label ?? "";
              const index = Number(dataPoint?.dataIndex);
              const slice = Number.isNaN(index) ? null : dataRef.current[index];
              const rawValue = slice?.rawValue;
              const value = rawValue ?? dataPoint?.formattedValue ?? "";
              const formattedValue =
                typeof value === "number"
                  ? value.toLocaleString("he-IL", { maximumFractionDigits: 2 })
                  : value;

              if (tooltipTitleRef.current) {
                tooltipTitleRef.current.textContent = label;
              }
              if (tooltipValueRef.current) {
                tooltipValueRef.current.textContent = formattedValue ? `${formattedValue} ₪` : "";
              }
              if (tooltipButtonRef.current) {
                tooltipButtonRef.current.style.display = onSliceDetailsRef.current ? "inline-flex" : "none";
                tooltipButtonRef.current.textContent = detailsLabel;
              }
              if (tooltipTransactionsButtonRef.current) {
                tooltipTransactionsButtonRef.current.style.display = onSliceTransactionsRef.current
                  ? "inline-flex"
                  : "none";
                tooltipTransactionsButtonRef.current.textContent = transactionsLabel;
              }

              tooltipEl.dataset.index = dataPoint?.dataIndex ?? "";
              tooltipEl.style.opacity = 1;
              tooltipEl.style.pointerEvents = "auto";
              tooltipEl.style.left = `${tooltip.caretX}px`;
              tooltipEl.style.top = `${tooltip.caretY}px`;
            },
          },
        },
      },
    });

    return () => chartRef.current?.destroy();
  }, [title, JSON.stringify(data), detailsLabel, transactionsLabel]);

  return (
    <div className="relative">
      <canvas ref={ref} />
      <div
        ref={tooltipRef}
        className="z-10"
        style={{
          position: "absolute",
          opacity: 0,
          pointerEvents: "none",
          transform: "translate(-50%, -110%)",
          background: "#0f172a",
          color: "#fff",
          padding: "10px 12px",
          borderRadius: "10px",
          minWidth: "120px",
          boxShadow: "0 10px 20px rgba(15, 23, 42, 0.25)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          alignItems: "flex-start",
        }}
      >
        <div ref={tooltipTitleRef} style={{ fontSize: "13px", fontWeight: 600 }} />
        <div ref={tooltipValueRef} style={{ fontSize: "12px" }} />
        <div style={{ display: "flex", gap: "6px" }}>
          <button
            ref={tooltipButtonRef}
            type="button"
            className="btn"
            style={{
              fontSize: "12px",
              padding: "4px 8px",
              backgroundColor: "#1e293b",
              color: "#f8fafc",
              border: "1px solid #0f172a",
            }}
          />
          <button
            ref={tooltipTransactionsButtonRef}
            type="button"
            className="btn"
            style={{
              fontSize: "12px",
              padding: "4px 8px",
              backgroundColor: "#334155",
              color: "#f8fafc",
              border: "1px solid #0f172a",
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function LineChart({ title, data = [], labels, datasets }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    const ctx = ref.current.getContext("2d");

    if (chartRef.current) chartRef.current.destroy();

    chartRef.current = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels || data.map((x) => x.label),
        datasets: normalizeDatasets({ data, datasets, title }),
      },
      options: {
        plugins: {
          legend: { display: Boolean(datasets && datasets.length > 1), position: "bottom" },
          title: { display: !!title, text: title },
        },
        scales: {
          y: { ticks: { callback: (v) => `${v} ₪` } },
        },
      },
    });

    return () => chartRef.current?.destroy();
  }, [title, JSON.stringify(data)]);

  return <canvas ref={ref} />;
}

export function BarChart({ title, data = [], labels, datasets }) {
  const ref = useRef(null)
  const chartRef = useRef(null)

  useEffect(() => {
    if (!ref.current) return
    const ctx = ref.current.getContext("2d")

    if (chartRef.current) chartRef.current.destroy()

    chartRef.current = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels || data.map((x) => x.label),
        datasets: normalizeDatasets({ data, datasets, title })
      },
      options: {
        plugins: {
          legend: { display: Boolean(datasets && datasets.length > 1), position: "bottom" },
          title: { display: !!title, text: title }
        },
        scales: {
          y: { ticks: { callback: (v) => v + " ₪" } }
        }
      }
    })

    return () => chartRef.current?.destroy()
  }, [title, JSON.stringify(data), JSON.stringify(labels), JSON.stringify(datasets)])

  return <canvas ref={ref} />
}
