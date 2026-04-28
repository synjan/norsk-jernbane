// Mobile hamburger-meny: 375px viewport, hamburger toggler topnav.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";
const findings = [];
function note(level, msg) { console.log(`[${level}] ${msg}`); findings.push({ level, msg }); }

async function shot(page, name) {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `mobile-${name}.png`), fullPage: true });
}

async function check(page, label) {
  // Hamburger skal være synlig
  const toggleVisible = await page.locator(".topnav-toggle").isVisible();
  note("info", `${label}: toggle visible = ${toggleVisible}`);
  if (!toggleVisible) note("fail", `${label}: hamburger ikke synlig på mobil`);

  // Topnav skjult som default
  const navOpenBefore = await page.locator(".topnav").evaluate(
    (el) => getComputedStyle(el).display !== "none"
  );
  if (navOpenBefore) note("fail", `${label}: topnav synlig før klikk`);

  // Klikk hamburger → topnav åpner
  await page.locator(".topnav-toggle").click();
  await page.waitForTimeout(150);
  const navOpenAfter = await page.locator(".topnav").evaluate(
    (el) => getComputedStyle(el).display !== "none"
  );
  if (!navOpenAfter) note("fail", `${label}: topnav åpnet ikke etter klikk`);
  note("info", `${label}: topnav åpen = ${navOpenAfter}`);

  // Lukk via Esc
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const navOpenEsc = await page.locator(".topnav").evaluate(
    (el) => getComputedStyle(el).display !== "none"
  );
  if (navOpenEsc) note("fail", `${label}: Esc lukket ikke topnav`);
}

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();

  for (const [path, label, ready] of [
    ["bane.html?navn=Bergensbanen", "bane", () => window.__route?.ready === true],
    ["dashboard.html", "dashboard", () => window.__dashboard?.ready === true],
    ["", "index", () => Boolean(window.__app?.state?.stats?.routes?.length)],
  ]) {
    note("step", `Åpner ${path || "/"} på 375px`);
    await page.goto(`${BASE_URL}/${path}`);
    await page.waitForFunction(ready, { timeout: 10_000 });
    await page.waitForTimeout(300);
    await shot(page, `${label}-closed`);
    await check(page, label);

    // Re-åpne for screenshot
    await page.locator(".topnav-toggle").click();
    await page.waitForTimeout(150);
    await shot(page, `${label}-open`);
  }

  await browser.close();
  const fails = findings.filter((f) => f.level === "fail");
  if (fails.length) {
    console.log("\nFEIL:");
    fails.forEach((f) => console.log("  " + f.msg));
    process.exit(1);
  }
  console.log("\nAlt OK.");
}

run().catch((e) => { console.error(e); process.exit(1); });
