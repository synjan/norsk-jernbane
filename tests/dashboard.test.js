// Smoketest for dashboard.html.
// Krever at serveren kjører på localhost:5174 (eller annen port via $BASE_URL).
// Kjør: node tests/dashboard.test.js

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
  await page.screenshot({ path: join(SCREENSHOT_DIR, `dashboard-${name}.png`), fullPage: true });
}

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  const url = `${BASE_URL}/dashboard.html`;
  note("step", `Åpner ${url}`);
  await page.goto(url);
  await page.waitForFunction(() => window.__dashboard?.ready === true, { timeout: 10_000 });
  await page.waitForTimeout(500);

  // Hero-tall: total km bør ligge i området ~5000–6000 (5377 i nåværende data)
  const heroKm = (await page.locator("#hero-km").textContent())?.trim() || "";
  note("info", `hero-km: ${heroKm}`);
  const km = parseInt(heroKm.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(km) || km < 4000 || km > 7000) {
    note("fail", `hero-km utenfor forventet område (4000-7000): ${heroKm}`);
  }

  for (const id of ["hero-elec", "hero-stations", "hero-routes"]) {
    const txt = (await page.locator(`#${id}`).textContent())?.trim() || "";
    note("info", `${id}: ${txt}`);
    if (!txt || txt === "—") {
      note("fail", `${id} er tomt eller placeholder`);
    }
  }

  // Minst 5 dash-cards
  const cards = await page.locator(".dash-card").count();
  note("info", `dash-cards: ${cards}`);
  if (cards < 5) note("fail", `Forventet minst 5 dash-cards, fikk ${cards}`);

  // Charts: minst 4 canvas-elementer skal være rendret (Chart.js setter width/height)
  const canvases = await page.locator(".dash-chart canvas").count();
  note("info", `chart-canvas: ${canvases}`);
  if (canvases < 4) note("fail", `Forventet >=4 chart-canvas, fikk ${canvases}`);

  // Topp 10 raskeste skal ha minst 5 rader
  const fastestRows = await page.locator("#dash-fastest li.dash-route-row").count();
  note("info", `fastest-rader: ${fastestRows}`);
  if (fastestRows < 5) note("fail", `Forventet >=5 fastest-rader, fikk ${fastestRows}`);

  // Befolkningsdekning skal være rendret (ikke bare placeholder)
  const popText = (await page.locator("#dash-population").textContent())?.trim() || "";
  if (!/innen 2 km/i.test(popText) && !/Mangler/i.test(popText)) {
    note("fail", `Befolkningsdekning ser ikke rendret ut: «${popText.slice(0, 80)}»`);
  }

  // S1: narrativ-paragraph skal være rendret med byer
  const narrative = (await page.locator("#dash-narrative").textContent())?.trim() || "";
  note("info", `narrativ (start): ${narrative.slice(0, 80)}…`);
  if (!/jernbane/i.test(narrative)) note("fail", "Narrativ mangler 'jernbane'-setning");
  if (!/(Ålesund|Tromsø|Haugesund)/i.test(narrative)) {
    note("fail", "Narrativ mangler navngitte byer");
  }

  // S2: hero har 5 kort (ikke 4)
  const heroCards = await page.locator(".dash-hero .dash-hero-card").count();
  note("info", `hero-kort: ${heroCards}`);
  if (heroCards !== 5) note("fail", `Forventet 5 hero-kort, fikk ${heroCards}`);

  // S5: datakvalitet-kort skal vise 4 prosenter
  const qualityRows = await page.locator("#dash-quality li").count();
  note("info", `datakvalitet-rader: ${qualityRows}`);
  if (qualityRows !== 4) note("fail", `Forventet 4 datakvalitet-rader, fikk ${qualityRows}`);

  // S3: sammenligning-kort skal vise minst 4 land med Norge fremhevet
  const compareRows = await page.locator("#dash-comparison .compare-row").count();
  const norwayHighlighted = await page.locator("#dash-comparison .compare-row.is-norway").count();
  note("info", `sammenligning-rader: ${compareRows}, Norge fremhevet: ${norwayHighlighted}`);
  if (compareRows < 4) note("fail", `Forventet >=4 sammenligning-rader, fikk ${compareRows}`);
  if (norwayHighlighted !== 1) note("fail", `Forventet 1 Norge-rad fremhevet, fikk ${norwayHighlighted}`);

  await shot(page, "01-overview");

  // S4: klikk på første accordion-header skal ekspandere detaljer + vise bane-lenke
  const firstHead = page.locator("#dash-fastest .dash-route-head").first();
  await firstHead.click();
  await page.waitForTimeout(200);
  const expandedLink = page.locator('#dash-fastest a[href^="bane.html?navn="]').first();
  const href = await expandedLink.getAttribute("href", { timeout: 5000 });
  note("info", `Etter accordion-klikk, lenke: ${href}`);
  if (!href || !href.includes("bane.html?navn=")) {
    note("fail", `Forventet bane-lenke i ekspandert detalj, fikk «${href}»`);
  }
  await expandedLink.click();
  await page.waitForFunction(() => window.__route?.ready === true, { timeout: 10_000 });
  const finalUrl = page.url();
  note("info", `Etter klikk: ${finalUrl}`);
  if (!finalUrl.includes("bane.html?navn=")) {
    note("fail", `Forventet bane.html-URL etter klikk, fikk ${finalUrl}`);
  }

  // Topbar konsistens: nav-link til dashbord skal markeres som aktiv på dashbord-siden
  await page.goto(url);
  await page.waitForFunction(() => window.__dashboard?.ready === true);
  const activeNav = await page.locator('.topnav a[aria-current="page"]').count();
  note("info", `aria-current=page nav-lenker: ${activeNav}`);
  if (activeNav !== 1) note("fail", `Forventet 1 aktiv nav-lenke, fikk ${activeNav}`);

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
