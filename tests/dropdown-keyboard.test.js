// Tastatur-navigasjon i bane-dropdown.
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";
const findings = [];
function note(level, msg) { console.log(`[${level}] ${msg}`); findings.push(msg); }

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto(`${BASE_URL}/dashboard.html`);
  await page.waitForFunction(() => window.__dashboard?.ready === true);
  await page.waitForTimeout(300);

  // Åpne dropdown
  note("step", "Åpner bane-dropdown");
  await page.locator(".nav-baner-toggle").click();
  await page.locator(".bane-row").first().waitFor({ timeout: 5_000 });

  // Søk skal ha fokus
  const focusedTag1 = await page.evaluate(() => document.activeElement?.className);
  note("info", `Etter open: focus på «${focusedTag1}»`);
  if (!focusedTag1.includes("bane-search")) {
    note("fail", `Forventet bane-search-fokus, fikk «${focusedTag1}»`);
  }

  // ArrowDown → første rad
  await page.keyboard.press("ArrowDown");
  const focusedTag2 = await page.evaluate(() => document.activeElement?.className);
  note("info", `Etter ArrowDown: focus på «${focusedTag2}»`);
  if (!focusedTag2.includes("bane-row")) {
    note("fail", "ArrowDown flyttet ikke fokus til bane-row");
  }

  // ArrowDown igjen → neste rad (sjekk href endres)
  const href1 = await page.evaluate(() => document.activeElement?.href);
  await page.keyboard.press("ArrowDown");
  const href2 = await page.evaluate(() => document.activeElement?.href);
  note("info", `href1=${href1?.slice(-30)}  href2=${href2?.slice(-30)}`);
  if (href1 === href2) note("fail", "ArrowDown flyttet ikke videre");

  // ArrowUp → tilbake til første
  await page.keyboard.press("ArrowUp");
  const href3 = await page.evaluate(() => document.activeElement?.href);
  if (href3 !== href1) note("fail", `ArrowUp gikk ikke tilbake (href3=${href3})`);

  // Enter på fokusert lenke → naviger
  note("step", "Enter på fokusert lenke");
  await Promise.all([
    page.waitForURL(/bane\.html\?navn=/, { timeout: 5_000 }),
    page.keyboard.press("Enter"),
  ]);
  note("ok", `Navigerte til ${page.url()}`);

  await browser.close();

  const fails = findings.filter((m) => m.startsWith("Forventet") || m.includes("flyttet ikke") || m.includes("gikk ikke"));
  if (fails.length) { console.log("FEIL:"); fails.forEach((f) => console.log("  " + f)); process.exit(1); }
  console.log("Alt OK.");
}

run().catch((e) => { console.error(e); process.exit(1); });
