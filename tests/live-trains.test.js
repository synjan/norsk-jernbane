// Verifiserer at live-tog-laget kobles på, henter fra Entur Vehicles og
// rendrer minst ett tog-marker (eller får en gyldig tom respons).

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      console.log(`[browser-${m.type()}] ${m.text()}`);
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    }
  });
  page.on("requestfailed", (req) =>
    console.log(`[reqfail] ${req.url()} ${req.failure()?.errorText}`)
  );

  console.log(`[step] Åpner ${BASE_URL}/`);
  await page.goto(BASE_URL);
  await page.waitForFunction(() => Boolean(window.__app?.state?.stationLayer));

  console.log("[step] Skru på 'Live tog'");
  await page.evaluate(() => {
    document.querySelectorAll("details").forEach((d) => { d.open = true; });
  });
  await page.locator("#show-live-trains").check();
  // Sjekk at state-flagget faktisk ble satt (event-handler kjørte)
  await page.waitForFunction(() => window.__app?.state?.showLiveTrains === true, { timeout: 5_000 });
  console.log(`[debug] showLiveTrains: ${await page.evaluate(() => window.__app.state.showLiveTrains)}`);
  // Vent på at refreshLiveTrains fullfører — opp til 8 s.
  await page.waitForFunction(
    () => window.__app?.state?.liveTrainsLastUpdate != null,
    { timeout: 12_000 }
  );

  const layerSize = await page.evaluate(() => {
    const layer = window.__app.state.liveTrainsLayer;
    return layer ? layer.getLayers().length : 0;
  });
  const lastUpdate = await page.evaluate(() => window.__app.state.liveTrainsLastUpdate);
  const cnt = await page.locator("#cnt-live-trains").innerText();

  console.log(`[info] tog-markører: ${layerSize}`);
  console.log(`[info] sidebar-teller: '${cnt}'`);
  console.log(`[info] lastUpdate: ${new Date(lastUpdate).toISOString()}`);

  let exitCode = 0;
  if (layerSize < 1) {
    // Det skal være tog i drift hver dag i Norge — null tog er rart.
    // Kanskje testen kjøres midt på natten.
    console.warn("WARN: 0 tog rendret — kan være OK om det er natten");
  }

  console.log("[step] Skru av igjen");
  await page.locator("#show-live-trains").uncheck();
  await page.waitForTimeout(300);
  const stillRendered = await page.evaluate(() => window.__app?.state?.liveTrainsLayer != null);
  if (stillRendered) {
    console.error("FAIL: laget ble ikke fjernet etter uncheck");
    exitCode = 1;
  }

  if (errors.length) {
    console.error(`FAIL: ${errors.length} JS-feil:`);
    errors.forEach((e) => console.error("  " + e));
    exitCode = 1;
  }

  await browser.close();
  if (exitCode === 0) console.log("Alt OK.");
  process.exit(exitCode);
}

run().catch((e) => { console.error(e); process.exit(1); });
