// Smoke-test for onepager.html — verifiserer at hero-stats lastes fra
// stats.json og at alle datakilder er listet.

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(`${BASE_URL}/onepager.html`);
  await page.waitForFunction(
    () => document.getElementById("stat-km").textContent !== "—",
    { timeout: 10_000 }
  );

  const km = await page.locator("#stat-km").innerText();
  const elec = await page.locator("#stat-elec").innerText();
  const stations = await page.locator("#stat-stations").innerText();
  const routes = await page.locator("#stat-routes").innerText();
  const featureCount = await page.locator(".op-feature").count();
  const sourceCount = await page.locator(".op-source").count();

  console.log(`[info] km=${km}, elec=${elec}, stations=${stations}, routes=${routes}`);
  console.log(`[info] features: ${featureCount}, sources: ${sourceCount}`);

  let exitCode = 0;
  if (km === "—" || km === "") { console.error("FAIL: km tom"); exitCode = 1; }
  if (featureCount < 8) { console.error(`FAIL: forventet >=8 features, fikk ${featureCount}`); exitCode = 1; }
  if (sourceCount < 5) { console.error(`FAIL: forventet >=5 sources, fikk ${sourceCount}`); exitCode = 1; }
  if (errors.length) {
    console.error(`FAIL: ${errors.length} JS-feil:`); errors.forEach((e) => console.error("  " + e));
    exitCode = 1;
  }

  await browser.close();
  if (exitCode === 0) console.log("Alt OK.");
  process.exit(exitCode);
}

run().catch((e) => { console.error(e); process.exit(1); });
