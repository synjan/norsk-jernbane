// Chart.js-wrappers — felles for kart (app.js) og dashbord (dashboard.js).
// Lastes etter Chart.js-CDN, før app.js / dashboard.js. Eksponerer
// `window.AppCharts.{doughnut, bar}` som returnerer/cacher Chart-instans
// per canvas-id (destroy-and-recreate).
//
// `onClick` er valgfri. Når satt blir foreldre-elementet markert med
// `.cursor-pointer` og onClick(index) kalles ved klikk på et segment/bar.
// Brukes på kart-siden for drill-down (klikk på doughnut → setter filter);
// dashbord trenger ikke det.

(function () {
  "use strict";

  const instances = new Map();

  function destroyAndCreate(canvasId, config, onClick, ariaLabel) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    const prev = instances.get(canvasId);
    if (prev) prev.destroy();
    if (ctx.parentElement) {
      ctx.parentElement.classList.toggle("cursor-pointer", Boolean(onClick));
    }
    if (ariaLabel) {
      ctx.setAttribute("role", "img");
      ctx.setAttribute("aria-label", ariaLabel);
    }
    const chart = new Chart(ctx, config);
    instances.set(canvasId, chart);
    return chart;
  }

  // Bygger en meningsfull aria-label fra labels+data ved å nevne topp-3.
  // Skjermlesere får en kort prosa-versjon i stedet for "Canvas".
  function buildAriaLabel(title, labels, data, unit = "") {
    if (!labels?.length) return title;
    const pairs = labels.map((l, i) => [l, data[i] || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    const rendered = pairs.map(([l, v]) => `${l}: ${Math.round(v).toLocaleString("nb-NO")}${unit}`).join(", ");
    return `${title}. Topp: ${rendered}.`;
  }

  function doughnut(canvasId, { labels, data, colors, onClick, ariaLabel, ariaTitle } = {}) {
    return destroyAndCreate(canvasId, {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: colors }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        onClick: onClick ? (_e, elements) => {
          if (elements.length) onClick(elements[0].index);
        } : undefined,
      },
    }, onClick, ariaLabel || (ariaTitle && buildAriaLabel(ariaTitle, labels, data, " km")));
  }

  function bar(canvasId, { labels, data, color, onClick, ariaLabel, ariaTitle } = {}) {
    return destroyAndCreate(canvasId, {
      type: "bar",
      data: { labels, datasets: [{ data, backgroundColor: color }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { callback: (v) => `${v} km` } } },
        onClick: onClick ? (_e, elements) => {
          if (elements.length) onClick(elements[0].index);
        } : undefined,
      },
    }, onClick, ariaLabel || (ariaTitle && buildAriaLabel(ariaTitle, labels, data, " km")));
  }

  window.AppCharts = { doughnut, bar, buildAriaLabel };
})();
