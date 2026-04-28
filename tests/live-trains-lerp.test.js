// Verifiserer at live tog-markørene faktisk animerer (LERP) mellom polls
// i stedet for å hoppe. Tar to snapshot av posisjonene rett etter en poll
// og sjekker at minst én markør har endret seg.

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

async function snapshot(page) {
  return page.evaluate(() => {
    const trains = window.__app?.state?.liveTrainsTrains;
    if (!trains) return [];
    const out = [];
    for (const [id, e] of trains) {
      const ll = e.marker.getLatLng();
      out.push({ id, lat: ll.lat, lng: ll.lng });
    }
    return out;
  });
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

  await page.goto(BASE_URL);
  await page.waitForFunction(() => Boolean(window.__app?.state?.stationLayer));
  await page.evaluate(() => {
    document.querySelectorAll("details").forEach((d) => { d.open = true; });
  });

  console.log("[step] Skru på Live tog");
  await page.locator("#show-live-trains").check();
  await page.waitForFunction(
    () => window.__app?.state?.liveTrainsLastUpdate != null,
    { timeout: 15_000 }
  );
  const initial = await snapshot(page);
  console.log(`[info] ${initial.length} markører etter første poll`);
  if (initial.length === 0) {
    console.warn("WARN: ingen tog rendret — kan være OK om det er natten");
    await browser.close();
    process.exit(0);
  }

  // Etter første poll setter LERP `from = to` → ingen bevegelse forventet
  // før neste poll. Etter andre poll (≈15s senere) vil hver markør tween-e
  // mot ny posisjon og bevege seg over LIVE_LERP_MS.
  console.log("[step] Vent på andre poll (~15 sek)…");
  const initialUpdate = await page.evaluate(() => window.__app.state.liveTrainsLastUpdate);
  await page.waitForFunction(
    (initialTs) => {
      const cur = window.__app?.state?.liveTrainsLastUpdate;
      return cur != null && cur > initialTs;
    },
    initialUpdate,
    { timeout: 25_000 }
  );

  // Vent ~3 sekunder inn i tween-en, da skal markørene være på vei.
  await page.waitForTimeout(3000);
  const mid = await snapshot(page);

  // Tell hvor mange som har beveget seg fra initial → mid.
  const initMap = new Map(initial.map((t) => [t.id, t]));
  let moved = 0;
  let totalDist = 0;
  for (const t of mid) {
    const before = initMap.get(t.id);
    if (!before) continue;
    const d = Math.hypot(t.lat - before.lat, t.lng - before.lng);
    if (d > 1e-7) {
      moved += 1;
      totalDist += d;
    }
  }
  console.log(`[info] markører som har beveget seg: ${moved} / ${mid.length} fellesmarkører`);
  console.log(`[info] sum delta-koordinat: ${totalDist.toExponential(3)}`);

  let exitCode = 0;
  if (moved === 0) {
    console.error("FAIL: ingen markører beveget seg — LERP fungerer ikke");
    exitCode = 1;
  }

  if (errors.length) {
    console.error(`FAIL: ${errors.length} JS-feil:`); errors.forEach((e) => console.error("  " + e));
    exitCode = 1;
  }

  await browser.close();
  if (exitCode === 0) console.log("Alt OK.");
  process.exit(exitCode);
}

run().catch((e) => { console.error(e); process.exit(1); });
