// Test av stasjons-kategorifilteret.
// Kjør: node tests/stations.test.js

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
  await page.screenshot({ path: join(SCREENSHOT_DIR, `stations-${name}.png`) });
}

async function visibleStations(page) {
  return page.evaluate(() => {
    const layer = window.__app.state.stationLayer;
    return layer ? layer.getLayers().length : 0;
  });
}

async function setStationType(page, type, checked) {
  const cb = page.locator(`.sidebar input[data-station-type="${type}"]`);
  if ((await cb.isChecked()) !== checked) await cb.click();
  await page.waitForTimeout(250);
}

async function clickBulk(page, action) {
  await page.locator(`button[data-bulk="${action}"]`).click();
  await page.waitForTimeout(300);
}

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  note("step", `Åpner ${BASE_URL}`);
  await page.goto(BASE_URL);
  await page.waitForFunction(() => Boolean(window.__app?.state?.stationLayer));
  await page.waitForTimeout(500);

  // Start: standard (station + halt). Ekskluderer T-bane/trikk/bybane.
  const defaultCount = await visibleStations(page);
  note("info", `Default-utvalg: ${defaultCount} stasjoner`);
  if (defaultCount > 500 || defaultCount < 300) {
    note("fail", `Default skulle være ~393, fikk ${defaultCount}`);
  }
  await shot(page, "01-default");

  // Alle på (station + halt + stop, kun tog-noder)
  await clickBulk(page, "stations-all");
  const allCount = await visibleStations(page);
  note("info", `Alle: ${allCount} stasjoner`);
  if (allCount < 1100 || allCount > 1400) {
    note("fail", `Alle skulle være ~1261, fikk ${allCount}`);
  }
  await shot(page, "02-all");

  // Ingen
  await clickBulk(page, "stations-none");
  const noneCount = await visibleStations(page);
  note("info", `Ingen: ${noneCount} stasjoner`);
  if (noneCount !== 0) note("fail", `Ingen skulle være 0, fikk ${noneCount}`);
  await shot(page, "03-none");

  // Tilbake til standard
  await clickBulk(page, "stations-default");
  const backDefault = await visibleStations(page);
  if (backDefault !== defaultCount)
    note("fail", `Standard etter ingen: ${backDefault} ≠ ${defaultCount}`);

  // Kun station
  await clickBulk(page, "stations-none");
  await setStationType(page, "station", true);
  const stationOnly = await visibleStations(page);
  note("info", `Kun station: ${stationOnly}`);
  if (stationOnly < 200 || stationOnly > 300) {
    note("fail", `Kun 'station' skulle være ~242, fikk ${stationOnly}`);
  }

  // UIC-toggle (overstyrer kategorifilter)
  await page.locator("#only-uic").click();
  await page.waitForTimeout(300);
  const uicOnly = await visibleStations(page);
  note("info", `Kun UIC-kodede: ${uicOnly}`);
  if (uicOnly < 30 || uicOnly > 60) {
    note("fail", `UIC-only skulle være ~50, fikk ${uicOnly}`);
  }
  await shot(page, "04-uic-only");

  // Reset
  await page.locator("#reset-filter").click();
  await page.waitForTimeout(400);
  const afterReset = await visibleStations(page);
  if (afterReset !== defaultCount)
    note("fail", `Reset → ${afterReset} ≠ default ${defaultCount}`);

  // Søk overstyrer kategorifilter: skjul alle, søk "Oslo S" (hovedstasjon)
  await clickBulk(page, "stations-none");
  await page.locator("#search").fill("Oslo S");
  await page.waitForTimeout(500);
  const searchHidden = await visibleStations(page);
  note("info", `Søk 'Oslo S' med alle kategorier av: ${searchHidden}`);
  if (searchHidden === 0) {
    note("fail", "Søk burde overstyre kategorifilter");
  }
  await shot(page, "05-search-overrides");

  if (errors.length) {
    note("fail", `JS-feil:`);
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
