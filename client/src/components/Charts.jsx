import React, { useEffect, useRef } from "react";
import Chart from "chart.js/auto";

export function PieChart({ title, data }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

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
        },
      },
    });

    return () => chartRef.current?.destroy();
  }, [title, JSON.stringify(data)]);

  return <canvas ref={ref} />;
}

export function LineChart({ title, data }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    const ctx = ref.current.getContext("2d");

    if (chartRef.current) chartRef.current.destroy();

    chartRef.current = new Chart(ctx, {
      type: "line",
      data: {
        labels: data.map((x) => x.label),
        datasets: [{ label: title || "סכום", data: data.map((x) => x.value) }],
      },
      options: {
        plugins: {
          legend: { display: false },
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
