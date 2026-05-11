// Test av "proff"-funksjonene: URL-state, hurtigtaster, statusbar, hjelpemodal.
// Kjør: node tests/pro.test.js

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || "http://localhost:5174";
const findings = [];
const errors = [];

function note(level, msg) {
  const line = `[${level}] ${msg}`;
  findings.push(line);
  console.log(line);
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
  await page.waitForFunction(() => Boolean(window.__app?.state?.railwayLayer));
  await page.waitForTimeout(500);

  // --- 1. Statusbar + Oversikt-KPI ---
  // Statusbaren ble slanket — km/elektrifisert% bor nå i Oversikt-gruppen
  // i sidebar (#stats-summary). Statusbar viser kun segmenter + filter.
  note("step", "Statusbar + Oversikt viser korrekte tall");
  const statsText = await page.evaluate(() => {
    const el = document.getElementById("stats-summary");
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  });
  const statusSeg = await page.locator("#status-segments").innerText();
  const statusFilter = await page.locator("#status-filter").innerText();
  note("info", `Oversikt: ${statsText}`);
  note("info", `Status: ${statusSeg} segm · ${statusFilter}`);
  if (!statsText.includes("km")) note("fail", `Oversikt mangler km-tall: '${statsText}'`);
  if (statusFilter !== "Standardvisning") note("fail", `Filter-status burde være 'Standardvisning', fikk '${statusFilter}'`);

  // --- 2. URL-state etter filter-endring ---
  note("step", "URL oppdateres når filter endres");
  await page.locator("#color-mode").selectOption("speed");
  await page.waitForTimeout(300);
  const urlAfterSpeed = page.url();
  if (!urlAfterSpeed.includes("cm=speed")) note("fail", `URL skulle inneholde cm=speed, fikk '${urlAfterSpeed}'`);
  note("info", `URL: ${urlAfterSpeed.split("#")[1] || "(ingen hash)"}`);

  // --- 3. URL-state restaureres etter reload ---
  note("step", "Tilstand restaureres etter reload");
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__app?.state?.railwayLayer));
  await page.waitForTimeout(500);
  const cmAfterReload = await page.evaluate(() => window.__app.state.colorMode);
  if (cmAfterReload !== "speed") note("fail", `colorMode skulle være 'speed' etter reload, fikk '${cmAfterReload}'`);
  note("info", `Restaurert colorMode: ${cmAfterReload}`);

  // Reset
  await page.locator("#reset-filter").click();
  await page.waitForTimeout(300);

  // --- 4. Hurtigtast '/' fokuserer søk ---
  note("step", "Hurtigtast '/' fokuserer søkefeltet");
  await page.locator("body").click();
  await page.keyboard.press("/");
  await page.waitForTimeout(150);
  const focused = await page.evaluate(() => document.activeElement.id);
  if (focused !== "search") note("fail", `Forventet #search fokusert, fikk '${focused}'`);

  // --- 5. Hurtigtast 'r' tilbakestiller filter ---
  note("step", "Hurtigtast 'r' tilbakestiller");
  await page.locator("#electrification-filter").selectOption("yes");
  await page.waitForTimeout(300);
  await page.locator("body").click();
  await page.keyboard.press("r");
  await page.waitForTimeout(300);
  const efAfter = await page.locator("#electrification-filter").inputValue();
  if (efAfter !== "all") note("fail", `Reset etter R: forventet 'all', fikk '${efAfter}'`);

  // --- 6. Hjelpemodal ---
  note("step", "Hjelpemodal med ? og Esc");
  await page.locator("body").click();
  await page.keyboard.press("?");
  await page.waitForTimeout(200);
  const modalOpen = await page.locator("#help-modal").evaluate((el) => el.classList.contains("open"));
  if (!modalOpen) note("fail", "Hjelpemodal åpnet ikke med ?");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const modalClosed = await page.locator("#help-modal").evaluate((el) => !el.classList.contains("open"));
  if (!modalClosed) note("fail", "Hjelpemodal lukket ikke med Escape");

  // --- 7. Eksport-knappen er bundet ---
  note("step", "Eksport-knappen finnes og er klikkbar");
  const exportExists = await page.locator("#btn-export").count();
  if (!exportExists) note("fail", "Eksport-knappen finnes ikke");

  // --- 8. Datadato vises ---
  note("step", "Datadato vises i statusbar");
  const dataDate = await page.locator("#data-date").innerText();
  if (!dataDate || dataDate === "—") note("fail", `Datadato mangler: '${dataDate}'`);
  else note("info", `Datadato: ${dataDate}`);

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
