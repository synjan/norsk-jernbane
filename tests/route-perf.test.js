// Verifiserer at bane.html laster per-rute geojson (routes/{slug}.geojson)
// og IKKE den 8 MB store railways.geojson. Beskytter mot regresjon hvis
// noen senere endrer fetch-oppsettet i bane.js.

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

function summary(results) {
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== OPPSUMMERING ===");
  if (fails.length === 0) {
    console.log("Alt OK.");
    return 0;
  }
  for (const f of fails) console.log(`  ✗ ${f.name}: ${f.detail}`);
  console.log(`${fails.length} feil av ${results.length}.`);
  return 1;
}

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const requests = [];
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/data/")) requests.push(u);
  });

  console.log(`[step] Åpner ${BASE_URL}/bane.html?navn=Bergensbanen`);
  await page.goto(`${BASE_URL}/bane.html?navn=Bergensbanen`);
  await page.waitForFunction(() => window.__route?.ready === true, { timeout: 10000 });

  const results = [];

  const loadedRoute = requests.some((u) => u.endsWith("/data/routes/bergensbanen.geojson"));
  results.push({
    name: "lastet routes/bergensbanen.geojson",
    ok: loadedRoute,
    detail: loadedRoute ? "" : `mangler i ${requests.join(", ")}`,
  });

  const loadedFullRailways = requests.some((u) => u.endsWith("/data/railways.geojson"));
  results.push({
    name: "ikke lastet full railways.geojson",
    ok: !loadedFullRailways,
    detail: loadedFullRailways ? "fortsatt lastet — defeats hele poenget" : "",
  });

  const loadedStats = requests.some((u) => u.endsWith("/data/stats.json"));
  results.push({
    name: "lastet stats.json",
    ok: loadedStats,
    detail: loadedStats ? "" : "mangler — bane.html trenger stats for route lookup",
  });

  // Verifiser at innholdet faktisk er rendret (ikke bare at fila ble lastet)
  const stationCount = await page.locator(".station-row").count();
  results.push({
    name: "stasjoner rendret fra rute-fil",
    ok: stationCount > 50,
    detail: stationCount > 50 ? "" : `bare ${stationCount} stasjoner — antar pipeline-feil`,
  });

  await browser.close();
  process.exit(summary(results));
}

run().catch((e) => {
  console.error("Uventet feil:", e);
  process.exit(2);
});
