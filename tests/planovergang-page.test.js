// Smoke-test for planovergang.html.
// Plukker første gyldige NVDB-ID fra planoverganger.geojson, åpner siden,
// verifiserer at hero, faktaboks og kontekst-seksjon renderer.

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

async function run() {
  // Hent en valid ID lokalt — unngår ekstern API-avhengighet for testen.
  const geo = JSON.parse(readFileSync(
    join(__dirname, "..", "public", "data", "planoverganger.geojson"),
    "utf-8"
  ));
  if (!geo.features.length) {
    console.error("FAIL: planoverganger.geojson har ingen features");
    process.exit(1);
  }
  const sampleId = geo.features[0].properties.id;
  console.log(`[step] Bruker NVDB-ID ${sampleId} (av ${geo.features.length} kryssinger)`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  await page.goto(`${BASE_URL}/planovergang.html?id=${sampleId}`);
  await page.waitForFunction(() => window.__plov?.ready === true, { timeout: 15_000 });

  let exitCode = 0;
  const empty = await page.evaluate(() => window.__plov?.empty);
  if (empty) {
    console.error(`FAIL: planovergang.html?id=${sampleId} markerte siden som tom`);
    exitCode = 1;
  }

  const heroCount = await page.locator(".dash-hero-card").count();
  if (heroCount < 4) {
    console.error(`FAIL: forventet 4 hero-kort, fikk ${heroCount}`);
    exitCode = 1;
  }
  console.log(`[info] hero-kort: ${heroCount}`);

  const mapCount = await page.locator("#planovergang-map").count();
  if (mapCount !== 1) {
    console.error("FAIL: mangler #planovergang-map");
    exitCode = 1;
  }

  const factsRows = await page.locator(".route-stats-card .micro-list li").count();
  console.log(`[info] fakta-rader: ${factsRows}`);
  if (factsRows < 4) {
    console.error(`FAIL: forventet >=4 fakta-rader, fikk ${factsRows}`);
    exitCode = 1;
  }

  const nvdbLink = await page.locator(".external-link").count();
  if (nvdbLink < 1) {
    console.error("FAIL: mangler NVDB-lenke");
    exitCode = 1;
  }

  // Test "ikke funnet"-tilstand
  console.log("[step] Verifiserer 'ikke funnet' for ugyldig ID");
  await page.goto(`${BASE_URL}/planovergang.html?id=invalid-id-zzz`);
  await page.waitForFunction(() => window.__plov?.ready === true, { timeout: 10_000 });
  const isEmpty = await page.evaluate(() => window.__plov?.empty);
  if (!isEmpty) {
    console.error("FAIL: ugyldig ID ble ikke markert som empty");
    exitCode = 1;
  }
  const emptyText = await page.locator(".route-empty p").first().innerText();
  if (!/invalid-id-zzz/.test(emptyText)) {
    console.error(`FAIL: empty-melding inneholder ikke ID: ${emptyText}`);
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
