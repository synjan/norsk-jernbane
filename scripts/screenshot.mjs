// Capture screenshots of index.html in different collapse states.
// Usage: BASE_URL=http://localhost:5174 node scripts/screenshot.mjs

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || "http://localhost:5174";
const OUT_DIR = join(__dirname, "screenshots");
const ts = Date.now();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE_URL);
await page.waitForFunction(() => Boolean(window.__app?.state?.railwayLayer), { timeout: 30000 });
await page.waitForTimeout(1500);

const states = [
  { name: "00-default", actions: [] },
  { name: "01-sidebar-hidden", actions: ["#toggle-sidebar"] },
  { name: "02-stats-hidden", actions: ["#toggle-sidebar", "#toggle-stats"] },  // toggle sidebar back, then hide stats
  { name: "03-both-hidden", actions: ["#toggle-sidebar"] },  // sidebar still hidden + stats still hidden = both
];

// Reset between captures by re-loading and applying actions cleanly
for (const { name, actions: _ignored } of states) { /* placeholder */ }

async function capture(name, action) {
  await page.goto(BASE_URL);
  await page.waitForFunction(() => Boolean(window.__app?.state?.railwayLayer), { timeout: 30000 });
  await page.waitForTimeout(800);
  if (action === "sidebar") await page.click("#toggle-sidebar");
  if (action === "stats") await page.click("#toggle-stats");
  if (action === "both") {
    await page.click("#toggle-sidebar");
    await page.click("#toggle-stats");
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT_DIR, `manual-${ts}-${name}.png`) });
}

await capture("00-default", null);
await capture("01-sidebar-hidden", "sidebar");
await capture("02-stats-hidden", "stats");
await capture("03-both-hidden", "both");

console.log(`Wrote 4 screenshots to ${OUT_DIR}/manual-${ts}-*.png`);
await browser.close();
