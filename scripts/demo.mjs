// Demo-video: scripted gjennomgang av prosjektets integrasjoner.
// Tar opp en .webm-video som viser alle funksjoner i bruk.
//
// Kjør: BASE_URL=http://localhost:5174 node scripts/demo.mjs
// Output: tests/videos/<timestamp>/demo.webm
//
// Krever at en server kjører (default 5174). For HD-oppløsning brukes
// 1600×900 viewport — Playwright's recordVideo fanger nøyaktig det.

import { chromium } from "playwright";
import { mkdirSync, existsSync, renameSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const VIDEO_DIR = join(__dirname, "videos", ts);
mkdirSync(VIDEO_DIR, { recursive: true });

function step(msg) {
  console.log(`▶ ${msg}`);
}

async function pause(page, ms) {
  await page.waitForTimeout(ms);
}

async function run() {
  step(`Starter Chromium med video-opptak → ${VIDEO_DIR}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1600, height: 900 } },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // ----- Scene 1: Hovedkart -----
  step("Scene 1: Åpner hovedkart");
  await page.goto(BASE_URL);
  await page.waitForFunction(() => Boolean(window.__app?.state?.stationLayer));
  await pause(page, 2000);

  // Zoom inn på Oslo-området
  step("Scene 1b: Zoom inn på Oslo");
  await page.evaluate(() => {
    window.__app.map.flyTo([59.91, 10.75], 11, { duration: 2 });
  });
  await pause(page, 3000);

  // ----- Scene 2: Fargemodus → hastighet -----
  step("Scene 2: Bytter fargemodus til hastighet");
  await page.locator("#color-mode").selectOption("speed");
  await pause(page, 2500);

  step("Scene 2b: Tilbake til elektrifisering");
  await page.locator("#color-mode").selectOption("electrification");
  await pause(page, 1500);

  // ----- Scene 3: Stasjons-popup med Entur sanntid -----
  step("Scene 3: Åpner Oslo S og viser sanntid + driftsmeldinger");
  await page.evaluate(() => {
    const layers = window.__app.state.stationLayer.getLayers();
    let best = null;
    let bestDist = Infinity;
    for (const l of layers) {
      const f = l.feature;
      if (!f || f.properties?.name !== "Oslo S") continue;
      const [lng, lat] = f.geometry.coordinates;
      const d = Math.hypot(lat - 59.911, lng - 10.7531);
      if (d < bestDist) { bestDist = d; best = l; }
    }
    if (best) best.openPopup();
  });
  // Vent på Entur-svar slik at avgangstabellen er synlig før vi tar bilde
  await page.waitForSelector(".leaflet-popup-content .dep-list, .leaflet-popup-content .dep-status:not(.muted-loading)",
    { timeout: 12_000 }).catch(() => {});
  await pause(page, 4500);

  // ----- Scene 4: Naviger til stasjonsside -----
  step("Scene 4: Klikker 'Åpne stasjonsside →'");
  const stationLink = page.locator(".leaflet-popup-content .station-page-link").first();
  if (await stationLink.count() > 0) {
    await stationLink.click();
    await page.waitForFunction(() => window.__station?.ready === true, { timeout: 15_000 });
    await pause(page, 2000);
  }

  // Scroll gjennom stasjonsside-seksjonene
  step("Scene 4b: Ruller gjennom alle seksjonene på stasjonssiden");
  // Åpne alle <details> så filterstatus ser bedre ut (har ingen, men generelt)
  for (const y of [200, 500, 900, 1300, 1700, 2100]) {
    await page.evaluate((py) => window.scrollTo({ top: py, behavior: "smooth" }), y);
    await pause(page, 1500);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await pause(page, 1200);

  // ----- Scene 5: Tilbake til kartet -----
  step("Scene 5: Tilbake til kart via topbar");
  await page.locator(".topbar a[data-page='index.html']").first().click();
  await page.waitForFunction(() => Boolean(window.__app?.state?.stationLayer));
  await pause(page, 1500);

  // ----- Scene 6: Tilleggslag — live tog + planoverganger -----
  step("Scene 6: Åpner Tilleggslag og slår på Live tog");
  await page.evaluate(() => {
    document.querySelectorAll("details").forEach((d) => { d.open = true; });
  });
  await pause(page, 1000);

  await page.locator("#show-live-trains").check();
  // Vent på første hentig
  await page.waitForFunction(
    () => window.__app?.state?.liveTrainsLastUpdate != null,
    { timeout: 15_000 }
  );
  await pause(page, 3500);

  step("Scene 6b: Slår på jernbanekryssinger (NVDB)");
  await page.locator("#show-planoverganger").check();
  await pause(page, 3500);

  // Zoom litt ut for å se mange tog + planoverganger samtidig
  step("Scene 6c: Zoomer ut for å vise hele Sør-Norge");
  await page.evaluate(() => {
    window.__app.map.flyTo([60.4, 10.5], 8, { duration: 3 });
  });
  await pause(page, 4000);

  // ----- Scene 7: Dashbord -----
  step("Scene 7: Åpner dashbord");
  await page.locator(".topbar a[data-page='dashboard.html']").first().click();
  await page.waitForLoadState("networkidle");
  await pause(page, 2500);

  step("Scene 7b: Ruller dashbordet");
  for (const y of [400, 1000, 1700, 2400]) {
    await page.evaluate((py) => window.scrollTo({ top: py, behavior: "smooth" }), y);
    await pause(page, 1500);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await pause(page, 1000);

  // ----- Scene 8: Bane-side (Bergensbanen) -----
  step("Scene 8: Bane-side for Bergensbanen");
  await page.goto(`${BASE_URL}/bane.html?navn=Bergensbanen`);
  await page.waitForFunction(() => window.__route?.ready === true, { timeout: 15_000 });
  await pause(page, 2500);

  step("Scene 8b: Ruller gjennom bane-siden");
  for (const y of [500, 1100, 1800]) {
    await page.evaluate((py) => window.scrollTo({ top: py, behavior: "smooth" }), y);
    await pause(page, 1500);
  }

  // ----- Scene 9: Onepager -----
  step("Scene 9: Onepager-oversikt");
  await page.goto(`${BASE_URL}/onepager.html`);
  await pause(page, 2000);
  for (const y of [400, 900, 1400]) {
    await page.evaluate((py) => window.scrollTo({ top: py, behavior: "smooth" }), y);
    await pause(page, 1300);
  }
  await pause(page, 1500);

  step("Avslutter — lagrer video");
  await context.close();
  await browser.close();

  // Playwright skriver videoen til VIDEO_DIR med et tilfeldig hex-navn.
  // Gi den et fornuftig navn.
  const files = readdirSync(VIDEO_DIR).filter((f) => f.endsWith(".webm"));
  if (files.length === 1) {
    const src = join(VIDEO_DIR, files[0]);
    const dst = join(VIDEO_DIR, "demo.webm");
    if (src !== dst) renameSync(src, dst);
    const sizeKB = (statSync(dst).size / 1024).toFixed(1);
    console.log(`\nVideo ferdig: ${dst} (${sizeKB} KB)`);
  } else {
    console.log(`\nFant ${files.length} video-filer i ${VIDEO_DIR}: ${files.join(", ")}`);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
