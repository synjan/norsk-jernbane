// Test av Entur-integrasjon: åpne Oslo S, sjekk at avganger vises eller fallback gir mening.
// Kjører mot live Entur API. Krever internett.
// Kjør: node tests/entur.test.js

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

function note(msg) { console.log(msg); }

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  note(`[step] Åpner ${BASE_URL}`);
  await page.goto(BASE_URL);
  await page.waitForFunction(() => Boolean(window.__app?.state?.stationLayer));
  // Tøm Entur-cache så testen alltid treffer nettverket.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("entur:")) localStorage.removeItem(k);
    }
  });
  await page.waitForTimeout(500);

  note("[step] Finn Oslo S og åpne popup");
  const opened = await page.evaluate(() => {
    const layers = window.__app.state.stationLayer.getLayers();
    // Oslo S har flere markører i OSM (perronger osv.). Velg den nærmest 59.911, 10.753.
    let best = null;
    let bestDist = Infinity;
    for (const l of layers) {
      const f = l.feature;
      if (!f || f.properties?.name !== "Oslo S") continue;
      const [lng, lat] = f.geometry.coordinates;
      const d = Math.hypot(lat - 59.9110, lng - 10.7531);
      if (d < bestDist) { bestDist = d; best = l; }
    }
    if (!best) return { ok: false, reason: "fant ikke Oslo S" };
    best.openPopup();
    const [lng, lat] = best.feature.geometry.coordinates;
    return { ok: true, lat, lng };
  });
  if (!opened.ok) {
    console.error(`FAIL: ${opened.reason}`);
    await browser.close();
    process.exit(1);
  }
  note(`[info] Åpnet popup på (${opened.lat}, ${opened.lng})`);

  note("[step] Vent på Entur-svar");
  await page.waitForFunction(() => {
    const slot = document.querySelector(".leaflet-popup-content .departures");
    if (!slot) return false;
    return Boolean(slot.querySelector(".dep-list, .dep-status:not(.muted-loading)"));
  }, { timeout: 20_000 }).catch(() => { /* la oss inspisere uansett */ });

  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SCREENSHOT_DIR, "entur-oslo-s.png") });

  const popupText = await page.locator(".leaflet-popup-content .departures").innerText().catch(() => "");
  note("[info] Popup-innhold:");
  popupText.split("\n").forEach((l) => note("  " + l));

  const hasList = await page.locator(".dep-list").count() > 0;
  const hasStatus = await page.locator(".dep-status").count() > 0;
  const hasError = await page.locator(".dep-status.error").count() > 0;

  let exitCode = 0;
  if (hasError) {
    const errText = await page.locator(".dep-status.error").innerText();
    console.error(`FAIL: Entur-kall feilet: ${errText}`);
    exitCode = 1;
  } else if (hasList) {
    const rowCount = await page.locator(".dep-list tr").count();
    note(`[ok] ${rowCount} avganger vist for Oslo S`);
    if (rowCount === 0) {
      console.error("FAIL: Tom avgangsliste");
      exitCode = 1;
    }
    // Sjekk at første rad har tid + linje + destinasjon
    const firstRow = await page.locator(".dep-list tr").first().innerText();
    note(`[info] Første avgang: ${firstRow.replace(/\n/g, " | ")}`);
    if (!/\d{2}:\d{2}/.test(firstRow)) {
      console.error(`FAIL: Tidsformat ser feil ut: ${firstRow}`);
      exitCode = 1;
    }
  } else if (hasStatus) {
    const status = await page.locator(".dep-status").innerText();
    note(`[warn] Status (ikke avgangsliste): ${status}`);
    // "Ingen Entur-data" eller "ingen togavganger" er gyldig svar.
  } else {
    console.error("FAIL: Verken liste, status eller feil i popup");
    exitCode = 1;
  }

  if (errors.length) {
    console.error(`FAIL: ${errors.length} JS-feil:`);
    errors.forEach((e) => console.error("  " + e));
    exitCode = 1;
  }

  await browser.close();
  if (exitCode === 0) note("Alt OK.");
  process.exit(exitCode);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
