// Eksplorativ test av filter-oppførsel.
// Kjør: node tests/filter.test.js
// Krever at serveren kjører på localhost:5174 (eller annen port via $BASE_URL).

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

const errors = [];
const findings = [];

function note(level, msg) {
  const line = `[${level}] ${msg}`;
  findings.push(line);
  console.log(line);
}

async function shot(page, name) {
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function waitForReady(page) {
  await page.waitForSelector("#stats-summary p", { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__app?.state?.railwayLayer));
  await page.waitForTimeout(800);
}

async function visibleSegmentCount(page) {
  return page.evaluate(() => window.__app.state.railwayLayer.getLayers().length);
}

async function liveStatsText(page) {
  // Oversikt-gruppen i sidebar er nå canonical kilde for "X km synlig" —
  // statusbaren ble slanket til kun segment-antall + filter for å unngå
  // duplisert info. Normaliserer whitespace så innerText sin newline-mellom-
  // noder ikke bryter substring-match (f.eks. "0 km").
  return page.evaluate(() => {
    const el = document.getElementById("stats-summary");
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  });
}

async function searchHintText(page) {
  return page.locator("#search-result").innerText();
}

async function setColorMode(page, value) {
  await page.locator("#color-mode").selectOption(value);
  await page.waitForTimeout(400);
}

async function toggleType(page, type, checked) {
  const cb = page.locator(`.sidebar input[data-type="${type}"]`);
  if ((await cb.isChecked()) !== checked) await cb.click();
  await page.waitForTimeout(250);
}

async function clickBulk(page, action) {
  await page.locator(`.sidebar button[data-bulk="${action}"]`).click();
  await page.waitForTimeout(300);
}

async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  note("step", `Åpner ${BASE_URL}`);
  await page.goto(BASE_URL);
  await waitForReady(page);
  await shot(page, "01-baseline");

  const baselineCount = await visibleSegmentCount(page);
  const baselineLive = await liveStatsText(page);
  note("info", `Baseline: ${baselineCount} segmenter`);
  note("info", `Live stats: ${baselineLive.replace(/\n/g, " | ")}`);

  // --- 1. Live stats reagerer på banetype-filter ---
  note("step", "Banetyper: skru av alt → live stats skal vise 0");
  await clickBulk(page, "types-none");
  const allOff = await visibleSegmentCount(page);
  const allOffLive = await liveStatsText(page);
  if (allOff !== 0) note("fail", `Forventet 0 segmenter, fikk ${allOff}`);
  if (!allOffLive.includes("0 km")) note("fail", `Live stats viser ikke 0 km: ${allOffLive}`);
  await shot(page, "02-types-none");

  await clickBulk(page, "types-all");
  const backOn = await visibleSegmentCount(page);
  if (backOn !== baselineCount)
    note("fail", `Tilbake til alle banetyper: forventet ${baselineCount}, fikk ${backOn}`);

  // --- 2. Smalspor (kun rail+narrow_gauge+preserved finnes nå) ---
  await clickBulk(page, "types-none");
  await toggleType(page, "narrow_gauge", true);
  const narrowGaugeCount = await visibleSegmentCount(page);
  note("info", `Smalspor-segmenter: ${narrowGaugeCount}`);
  if (narrowGaugeCount === 0) note("fail", "Smalspor-checkbox virker ikke");
  await clickBulk(page, "types-all");

  // --- 3. Operatørfilter ---
  note("step", "Operatørfilter: 'Ingen' → 0 km");
  // Åpne operatørgruppen først (kollapset som default i sidebaren)
  await page.evaluate(() => {
    const summaries = document.querySelectorAll(".sidebar details.group > summary");
    for (const s of summaries) {
      if (s.textContent.includes("Operatør")) s.parentElement.open = true;
    }
  });
  await page.waitForTimeout(200);
  await page.locator('button[data-bulk="ops-none"]').click();
  await page.waitForTimeout(300);
  const opNoneCount = await visibleSegmentCount(page);
  if (opNoneCount !== 0)
    note("fail", `Etter 'Operatører: ingen' forventet 0, fikk ${opNoneCount}`);
  await shot(page, "03-operators-none");

  // Sjekk én spesifikk operatør (Bane NOR forventes å være toppen).
  await page.locator('input[data-operator="Bane NOR"]').click();
  await page.waitForTimeout(300);
  const baneNorOnly = await visibleSegmentCount(page);
  note("info", `Kun Bane NOR: ${baneNorOnly} segmenter`);
  if (baneNorOnly === 0) note("fail", "Bane NOR-filter ga 0 segmenter — sannsynligvis bug");

  await page.locator('button[data-bulk="ops-all"]').click();
  await page.waitForTimeout(300);

  // --- 4. Søk ---
  note("step", "Søk: 'gardermo'");
  await page.locator("#search").fill("gardermo");
  await page.waitForTimeout(500);
  const gardermoLive = await liveStatsText(page);
  const gardermoHint = await searchHintText(page);
  note("info", `Treff: ${gardermoHint}`);
  if (!gardermoHint.match(/\d+ treff/)) note("fail", `Søkehint mangler treff-tall: ${gardermoHint}`);
  await shot(page, "04-search-gardermo");

  await page.locator("#search").fill("");
  await page.waitForTimeout(400);
  const afterClear = await visibleSegmentCount(page);
  if (afterClear !== baselineCount)
    note("fail", `Etter tom søk: forventet ${baselineCount}, fikk ${afterClear}`);

  // --- 5. Reset ---
  note("step", "Reset etter rotete tilstand");
  await clickBulk(page, "types-none");
  await page.locator("#search").fill("foo");
  await page.waitForTimeout(300);
  await page.locator("#reset-filter").click();
  await page.waitForTimeout(400);
  const afterReset = await visibleSegmentCount(page);
  if (afterReset !== baselineCount)
    note("fail", `Etter reset: forventet ${baselineCount}, fikk ${afterReset}`);
  await shot(page, "05-after-reset");

  // --- 6. Color mode ---
  note("step", "Fargemodus");
  for (const mode of ["speed", "type", "electrification"]) {
    await setColorMode(page, mode);
    await shot(page, `06-color-${mode}`);
  }

  // --- 7. Legende ---
  note("step", "Legende reagerer på fargemodus");
  for (const mode of ["electrification", "speed", "type"]) {
    await setColorMode(page, mode);
    const txt = await page.locator("#legend").innerText();
    if (!txt) note("fail", `Legende mangler tekst for fargemodus '${mode}'`);
    note("info", `legende(${mode}): ${txt.replace(/\n/g, " | ").slice(0, 80)}`);
    await shot(page, `07-legend-${mode}`);
  }
  await setColorMode(page, "electrification");

  // --- 8. Elektrifiseringsfilter ---
  note("step", "Elektrifiseringsfilter");
  await page.locator("#electrification-filter").selectOption("yes");
  await page.waitForTimeout(400);
  const elecOnlyCount = await visibleSegmentCount(page);
  note("info", `Bare elektrifisert: ${elecOnlyCount} segmenter`);
  if (elecOnlyCount === 0) note("fail", "Elektrifiseringsfilter 'yes' ga 0 — sannsynligvis bug");
  if (elecOnlyCount === baselineCount) note("fail", "Elektrifiseringsfilter 'yes' filtrerte ingenting bort");

  await page.locator("#electrification-filter").selectOption("no");
  await page.waitForTimeout(400);
  const noElecCount = await visibleSegmentCount(page);
  note("info", `Bare ikke-elektrifisert: ${noElecCount} segmenter`);
  if (elecOnlyCount + noElecCount !== baselineCount) {
    note("fail", `Elektrifisert + ikke-elektrifisert (${elecOnlyCount} + ${noElecCount} = ${elecOnlyCount + noElecCount}) skulle vært ${baselineCount}`);
  }
  await page.locator("#electrification-filter").selectOption("all");
  await page.waitForTimeout(300);

  // --- 9. Stats-panel synkronisering ---
  note("step", "Stats-panel oppdateres med filter");
  // Med kun rail valgt skal Filtrert utvalg-indikatoren vises og km
  // skal være lavere enn baseline (siden vi ekskluderer narrow_gauge+preserved).
  await clickBulk(page, "types-none");
  await toggleType(page, "rail", true);
  await page.waitForTimeout(400);
  const summary = await page.locator("#stats-summary").innerText();
  note("info", `Stats med kun rail: ${summary.replace(/\n/g, " | ")}`);
  if (!summary.toLowerCase().includes("filtrert utvalg")) {
    note("fail", `Stats viser ikke 'filtrert utvalg'-indikator: ${summary}`);
  }
  const elecMatch = summary.match(/(\d+[.,]\d+)\s*%/);
  const pct = elecMatch ? parseFloat(elecMatch[1].replace(",", ".")) : 0;
  if (pct < 50 || pct > 80) {
    note("fail", `Stats viser ${pct}% elektrifisert for rail (forventet 50-80%)`);
  } else {
    note("info", `Rail elektrifisert-andel: ${pct}%`);
  }
  await shot(page, "08-stats-rail-only");

  await page.locator("#reset-filter").click();
  await page.waitForTimeout(400);

  // (Tidligere: doughnut-klikk satte elektrifiseringsfilter. Fjernet sammen
  // med chart-panelene — kart-siden viser nå bare summary, dashbord har charts.)

  // --- 11. Console errors ---
  if (errors.length) {
    note("fail", `Fant ${errors.length} feil i nettleseren:`);
    errors.forEach((e) => note("err", e));
  } else {
    note("ok", "Ingen console errors");
  }

  await browser.close();

  console.log("\n=== OPPSUMMERING ===");
  const fails = findings.filter((l) => l.startsWith("[fail]") || l.startsWith("[err]"));
  if (fails.length) {
    console.log(`${fails.length} feil/problemer:`);
    fails.forEach((f) => console.log("  " + f));
    process.exit(1);
  } else {
    console.log("Alt OK.");
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
