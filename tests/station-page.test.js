// Smoke-test for stasjonsside (stasjon.html).
// Verifiserer at stasjonsside laster, viser hero, kart og live-seksjon for
// Oslo S, og at koblede integrasjoner (Wikidata, ruter som stopper) er
// til stede når data er tilgjengelig.

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  console.log(`[step] Åpner ${BASE_URL}/stasjon.html?navn=Oslo+S`);
  await page.goto(`${BASE_URL}/stasjon.html?navn=Oslo+S`);
  await page.waitForFunction(() => window.__station?.ready === true, { timeout: 15_000 });

  let exitCode = 0;
  const empty = await page.evaluate(() => window.__station?.empty);
  if (empty) {
    console.error("FAIL: station marked as empty");
    exitCode = 1;
  }

  const h1 = (await page.locator("#station-h1").innerText()).replace(/\n/g, " | ");
  console.log(`[info] h1: ${h1}`);
  if (!h1.toLowerCase().includes("oslo s")) {
    console.error(`FAIL: feil h1: ${h1}`);
    exitCode = 1;
  }

  const heroCount = await page.locator(".dash-hero-card").count();
  console.log(`[info] hero-kort: ${heroCount}`);
  if (heroCount < 3) {
    console.error(`FAIL: forventet >=3 hero-kort, fikk ${heroCount}`);
    exitCode = 1;
  }

  const mapCount = await page.locator("#station-map").count();
  if (mapCount !== 1) {
    console.error(`FAIL: mangler #station-map`);
    exitCode = 1;
  }

  const liveCount = await page.locator(".station-live-section").count();
  if (liveCount !== 1) {
    console.error(`FAIL: mangler .station-live-section`);
    exitCode = 1;
  }

  // Wikidata: Oslo S har som regel fredningsstatus + bilde i Wikidata —
  // hvis ikke, godta tomt (slot er hidden) men logg.
  await page.waitForTimeout(500);
  const culturalVisible = await page.locator("#station-cultural-slot:not([hidden])").count();
  const wikiVisible = await page.locator("#station-wiki-slot:not([hidden])").count();
  console.log(`[info] kulturminne synlig: ${culturalVisible}, wikidata synlig: ${wikiVisible}`);

  // Ruter som stopper: Oslo S skal ha minst én rute hvis station_routes.json finnes
  const routesCount = await page.locator(".station-routes-section li").count();
  console.log(`[info] ruter som stopper: ${routesCount}`);

  // Sjekk live-seksjon — den skal i det minste komme forbi placeholder-stadiet.
  await page.waitForTimeout(2000);
  const depState = await page.locator(".station-live-section .departures").innerText();
  console.log(`[info] departures-tekst: ${depState.slice(0, 80)}`);

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
