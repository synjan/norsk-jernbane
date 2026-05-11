// Verifiserer datavolum-strategien (punkt 1 fra optimaliseringsplanen):
// 1) Initial last bruker railways-overview.geojson, ikke full
// 2) Full railways.geojson lastes ikke på defaultzoom
// 3) Full lastes når brukeren zoomer inn til >= ZOOM_LOAD_FULL_THRESHOLD (10)

import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:5174";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const dataRequests = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/data/railways")) {
      dataRequests.push(url);
    }
  });

  console.log(`[step] Åpner ${BASE} på defaultzoom (5)`);
  await page.goto(BASE);
  await page.waitForFunction(() => window.__app?.state?.railwaysData != null);

  const initialLoaded = dataRequests.some((u) => u.endsWith("/railways-overview.geojson"));
  const initialFullLoaded = dataRequests.some((u) => u.endsWith("/railways.geojson"));

  console.log(`[info] Etter init: overview=${initialLoaded}, full=${initialFullLoaded}`);
  if (!initialLoaded) throw new Error("railways-overview.geojson ble ikke lastet ved init");
  if (initialFullLoaded) throw new Error("railways.geojson ble lastet for tidlig (skal vente til zoom>=10)");

  console.log("[step] Zoomer inn til 10 — full skal lastes nå");
  await page.evaluate(() => window.__app.map.setZoom(10));
  await page.waitForFunction(
    () => window.__app?.state?.railwaysIsFull === true,
    { timeout: 10000 }
  );

  const afterZoomFull = dataRequests.some((u) => u.endsWith("/railways.geojson"));
  console.log(`[info] Etter zoom 10: full=${afterZoomFull}`);
  if (!afterZoomFull) throw new Error("railways.geojson ble ikke lastet etter zoom-inn");

  console.log("[step] Zoom-tilbake skal IKKE re-laste full");
  const beforeZoomOut = dataRequests.length;
  await page.evaluate(() => window.__app.map.setZoom(5));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__app.map.setZoom(11));
  await page.waitForTimeout(500);

  const afterZoomOut = dataRequests.length;
  console.log(`[info] Antall data-requests før=${beforeZoomOut}, etter=${afterZoomOut}`);
  if (afterZoomOut !== beforeZoomOut) {
    throw new Error("railways.geojson ble lastet flere ganger — ensureFullRailwaysLoaded er ikke idempotent");
  }

  await browser.close();
  console.log("\n=== OPPSUMMERING ===");
  console.log("Alt OK.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
