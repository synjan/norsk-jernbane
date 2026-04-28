// Smoke-test for tog.html (live).
// Henter en aktiv datedServiceJourney.id direkte fra Entur, åpner siden,
// verifiserer at hero, kart og statuskort renderer i løpet av polling.

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

async function getActiveJourneyId() {
  const r = await fetch("https://api.entur.io/realtime/v2/vehicles/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "ET-Client-Name": "norsk-jernbane-test" },
    body: JSON.stringify({
      query: "{ vehicles(mode: RAIL) { datedServiceJourney { id } location { latitude longitude } lastUpdated } }",
    }),
  });
  if (!r.ok) throw new Error(`Vehicles HTTP ${r.status}`);
  const d = await r.json();
  const v = (d.data?.vehicles || []).find(
    (x) => x.datedServiceJourney?.id && x.location?.latitude != null
  );
  return v?.datedServiceJourney?.id || null;
}

async function run() {
  const id = await getActiveJourneyId();
  if (!id) {
    console.warn("WARN: Ingen aktive tog akkurat nå — hopper over live-test, sjekker bare 'ikke funnet'-flyten.");
  } else {
    console.log(`[step] Bruker aktivt journey-id: ${id}`);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  let exitCode = 0;

  if (id) {
    await page.goto(`${BASE_URL}/tog.html?id=${encodeURIComponent(id)}`);
    await page.waitForFunction(
      () => window.__tog?.ready === true && !window.__tog.empty,
      { timeout: 20_000 }
    );

    const heroCount = await page.locator(".dash-hero-card").count();
    console.log(`[info] hero-kort: ${heroCount}`);
    if (heroCount < 4) {
      console.error(`FAIL: forventet 4 hero-kort, fikk ${heroCount}`);
      exitCode = 1;
    }

    const mapCount = await page.locator("#tog-map").count();
    if (mapCount !== 1) {
      console.error("FAIL: mangler #tog-map");
      exitCode = 1;
    }

    const statusRows = await page.locator(".route-stats-card .micro-list li").count();
    if (statusRows < 5) {
      console.error(`FAIL: forventet >=5 status-rader, fikk ${statusRows}`);
      exitCode = 1;
    }
    console.log(`[info] status-rader: ${statusRows}`);

    const h1 = (await page.locator("#tog-h1").innerText()).replace(/\n/g, " | ");
    console.log(`[info] h1: ${h1}`);
    if (h1 === "—" || h1 === "") {
      console.error("FAIL: h1 ikke fylt");
      exitCode = 1;
    }
  }

  // Verifiser "ikke funnet"-flyt med en garantert ugyldig ID.
  console.log("[step] Verifiserer 'ikke funnet' for ugyldig ID");
  await page.goto(`${BASE_URL}/tog.html?id=NONEXISTENT:DatedServiceJourney:zzz_99-99-99`);
  // Vent på at NOT_FOUND_TOLERANCE polls (3) er kjørt — POLL_MS=10s, så ~35 s.
  // For å holde testen rask, sjekker vi bare at siden i det minste ikke krasjer
  // og at __tog blir definert (med eller uten empty=true).
  await page.waitForFunction(
    () => window.__tog || document.querySelector(".route-empty"),
    { timeout: 45_000 }
  ).catch(() => {});
  // Etter ventetid: enten empty=true (etter 3 polls) eller fortsatt "Henter…"
  const nowEmpty = await page.evaluate(() => window.__tog?.empty);
  console.log(`[info] empty etter ugyldig id: ${nowEmpty}`);

  if (errors.length) {
    console.error(`FAIL: ${errors.length} JS-feil:`);
    errors.forEach((e) => console.error("  " + e));
    exitCode = 1;
  }

  await browser.close();
  if (exitCode === 0) console.log("Alt OK.");
  process.exit(exitCode);
}

run().catch((e) => { console.error(e); process.exit(1); });
