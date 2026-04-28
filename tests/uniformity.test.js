// Sjekker at topbar + page-header har samme dimensjoner og struktur
// på tvers av alle 3 sider. Fanger regresjoner i visuell uniformitet.

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";
const findings = [];
function note(level, msg) { console.log(`[${level}] ${msg}`); findings.push({ level, msg }); }

async function measure(page) {
  return page.evaluate(() => {
    const topbar = document.querySelector(".topbar");
    const header = document.querySelector(".page-header");
    return {
      topbarH: topbar?.getBoundingClientRect().height ?? 0,
      topbarBg: topbar ? getComputedStyle(topbar).backgroundColor : null,
      headerExists: Boolean(header),
      headerBg: header ? getComputedStyle(header).backgroundColor : null,
      hasH1: Boolean(header?.querySelector("h1")),
      hasNav: Boolean(document.querySelector(".topbar .topnav")),
    };
  });
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const results = {};

  for (const [path, label, ready] of [
    ["", "index", () => Boolean(window.__app?.state?.stats?.routes?.length)],
    ["dashboard.html", "dashboard", () => window.__dashboard?.ready === true],
    ["bane.html?navn=Bergensbanen", "bane", () => window.__route?.ready === true],
  ]) {
    await page.goto(`${BASE_URL}/${path}`);
    await page.waitForFunction(ready, { timeout: 10_000 });
    await page.waitForTimeout(200);
    results[label] = await measure(page);
    note("info", `${label}: ${JSON.stringify(results[label])}`);
  }

  // Likhetssjekker
  const heights = Object.values(results).map((r) => r.topbarH);
  if (Math.max(...heights) - Math.min(...heights) > 1) {
    note("fail", `topbar-høyder ulike: ${heights.join(", ")}`);
  }

  const bgs = new Set(Object.values(results).map((r) => r.topbarBg));
  if (bgs.size > 1) note("fail", `topbar-bg ulik: ${[...bgs].join(" vs ")}`);

  for (const [label, r] of Object.entries(results)) {
    if (!r.headerExists) note("fail", `${label}: mangler .page-header`);
    if (!r.hasH1) note("fail", `${label}: mangler h1 i .page-header`);
    if (!r.hasNav) note("fail", `${label}: mangler .topbar .topnav`);
  }

  await browser.close();
  const fails = findings.filter((f) => f.level === "fail");
  if (fails.length) {
    console.log("\nFEIL:");
    fails.forEach((f) => console.log("  " + f.msg));
    process.exit(1);
  }
  console.log("\nAlt OK.");
}
run().catch((e) => { console.error(e); process.exit(1); });
