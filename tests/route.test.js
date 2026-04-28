// Smoketest for bane.html (per-rute side).
// Krever at serveren kjører på localhost:5174 (eller annen port via $BASE_URL).
// Kjør: node tests/route.test.js

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";
const findings = [];
const errors = [];

function note(level, msg) {
  const line = `[${level}] ${msg}`;
  findings.push(line);
  console.log(line);
}

async function shot(page, name) {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `route-${name}.png`) });
}

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  // 1) Bergensbanen — happy path
  const url1 = `${BASE_URL}/bane.html?navn=Bergensbanen`;
  note("step", `Åpner ${url1}`);
  await page.goto(url1);
  await page.waitForFunction(() => window.__route?.ready === true, { timeout: 10_000 });
  await page.waitForTimeout(400);

  const empty = await page.evaluate(() => Boolean(window.__route?.empty));
  if (empty) note("fail", "Bergensbanen ble ikke funnet i stats.routes");

  const h1 = (await page.locator("h1").first().textContent())?.trim() || "";
  note("info", `H1: ${h1}`);
  if (!/bergensbanen/i.test(h1)) {
    note("fail", `Forventet H1 med 'Bergensbanen', fikk «${h1}»`);
  }

  const breadcrumb = (await page.locator("#crumb-current").textContent())?.trim() || "";
  note("info", `Brødsmule: ${breadcrumb}`);
  if (!/bergensbanen/i.test(breadcrumb)) {
    note("fail", `Brødsmule mangler rutenavn: «${breadcrumb}»`);
  }

  // Leaflet-kart skal ha rendret. Leaflet legger .leaflet-container på map-div
  // selv (ikke som child), så vi sjekker også interne panes.
  const hasMapClass = await page.locator("#route-map.leaflet-container").count();
  const hasPane = await page.locator("#route-map .leaflet-pane").count();
  note("info", `leaflet-container på rot: ${hasMapClass}, panes: ${hasPane}`);
  if (hasMapClass === 0 || hasPane === 0) {
    note("fail", "Leaflet ser ikke initialisert i #route-map");
  }

  // Total km bør være > 300 (Bergensbanen er ~398 km)
  const totalKmText = await page.locator(".route-stats-card").first().textContent();
  const kmMatch = (totalKmText || "").match(/(\d{2,4}(?:[.,]\d+)?)\s*km/);
  const totalKm = kmMatch ? parseFloat(kmMatch[1].replace(",", ".")) : 0;
  note("info", `Hentet 'km' fra stats-card: ${totalKm}`);
  if (totalKm < 300) note("fail", `Forventet >300 km for Bergensbanen, fikk ${totalKm}`);

  // Stasjon-rader langs banen
  const stationRows = await page.locator(".station-row").count();
  note("info", `Stasjonsrader: ${stationRows}`);
  if (stationRows < 5) note("fail", `Forventet >=5 stasjoner langs Bergensbanen, fikk ${stationRows}`);

  await shot(page, "01-bergensbanen");

  // 2) Ugyldig navn — empty state
  const url2 = `${BASE_URL}/bane.html?navn=Tullebanen42`;
  note("step", `Åpner ${url2}`);
  await page.goto(url2);
  await page.waitForFunction(() => window.__route?.ready === true, { timeout: 10_000 });

  const isEmpty = await page.evaluate(() => Boolean(window.__route?.empty));
  if (!isEmpty) note("fail", "Ugyldig navn skulle gi empty state");

  const emptyText = (await page.locator(".route-empty").textContent())?.trim() || "";
  note("info", `Empty-state-tekst: ${emptyText.slice(0, 80)}…`);
  if (!/ikke funnet/i.test(emptyText)) {
    note("fail", "Empty-state mangler 'ikke funnet'-tekst");
  }
  await shot(page, "02-empty-state");

  // 3) Manglende ?navn= — også empty state
  const url3 = `${BASE_URL}/bane.html`;
  note("step", `Åpner ${url3}`);
  await page.goto(url3);
  await page.waitForFunction(() => window.__route?.ready === true, { timeout: 10_000 });
  const noParamEmpty = await page.evaluate(() => Boolean(window.__route?.empty));
  if (!noParamEmpty) note("fail", "Manglende ?navn= skulle gi empty state");

  // (Tidligere: åpnet Bergensbanen i kart-sidens fastest-list og klikket
  // «Åpne bane-side». Lista er fjernet — bane-sider åpnes nå via Baner-
  // dropdown i topbar i stedet.)

  if (errors.length) {
    note("fail", "JS-feil:");
    errors.forEach((e) => note("err", e));
  } else {
    note("ok", "Ingen console errors");
  }

  await browser.close();

  console.log("\n=== OPPSUMMERING ===");
  const fails = findings.filter((l) => l.startsWith("[fail]") || l.startsWith("[err]"));
  if (fails.length) {
    console.log(`${fails.length} feil:`);
    fails.forEach((f) => console.log("  " + f));
    process.exit(1);
  }
  console.log("Alt OK.");
}

run().catch((e) => { console.error(e); process.exit(1); });
