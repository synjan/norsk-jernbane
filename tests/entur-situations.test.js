// Test av fetchSituations + popup-rendering for SIRI-SX-driftsmeldinger.
// Mocker Entur GraphQL slik at vi kontrollerer responsen — uten denne mocken
// kan testen være flaky avhengig av om det faktisk er aktive avvik på Oslo S.
// Kjør: node tests/entur-situations.test.js

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

const STOP_RESPONSE = {
  data: {
    stopPlacesByBbox: [
      {
        id: "NSR:StopPlace:337",
        name: "Oslo S",
        transportMode: ["rail"],
        latitude: 59.9110,
        longitude: 10.7531,
      },
    ],
  },
};

const DEPARTURES_RESPONSE = {
  data: {
    stopPlace: {
      name: "Oslo S",
      estimatedCalls: [
        {
          expectedDepartureTime: new Date(Date.now() + 600000).toISOString(),
          aimedDepartureTime: new Date(Date.now() + 600000).toISOString(),
          realtime: true,
          forBoarding: true,
          destinationDisplay: { frontText: "Drammen" },
          quay: { publicCode: "8" },
          serviceJourney: { line: { publicCode: "L12", name: "Linje 12", transportMode: "rail" } },
        },
      ],
    },
  },
};

const SITUATIONS_RESPONSE = {
  data: {
    stopPlace: {
      situations: [
        {
          summary: [{ value: "Innstilte tog Oslo–Drammen", language: "no" }],
          description: [{ value: "Signalfeil mellom Lysaker og Sandvika fører til innstilte avganger.", language: "no" }],
          advice: [{ value: "Bruk buss for tog.", language: "no" }],
          validityPeriod: {
            startTime: new Date(Date.now() - 3600000).toISOString(),
            endTime: new Date(Date.now() + 3600000).toISOString(),
          },
          severity: "severe",
          reportType: "incident",
        },
        {
          summary: [{ value: "Utløpt melding", language: "no" }],
          description: [{ value: "Skal ikke vises", language: "no" }],
          advice: null,
          validityPeriod: {
            startTime: new Date(Date.now() - 7200000).toISOString(),
            endTime: new Date(Date.now() - 3600000).toISOString(),
          },
          severity: "slight",
          reportType: "general",
        },
      ],
    },
  },
};

function pickResponse(body) {
  const op = body.query?.match(/query\s+(\w+)/)?.[1];
  if (op === "stopByBbox") return STOP_RESPONSE;
  if (op === "departures") return DEPARTURES_RESPONSE;
  if (op === "situations") return SITUATIONS_RESPONSE;
  return { data: null, errors: [{ message: `Ukjent operasjon ${op}` }] };
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.route("**/api.entur.io/journey-planner/**", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    const payload = pickResponse(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  console.log(`[step] Åpner ${BASE_URL}`);
  await page.goto(BASE_URL);
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("entur:"))
      .forEach((k) => localStorage.removeItem(k));
  });
  await page.waitForFunction(() => Boolean(window.__app?.state?.stationLayer));

  console.log("[step] Direkte test av fetchSituations");
  const direct = await page.evaluate(async () => {
    const list = await window.Entur.fetchSituations("NSR:StopPlace:337");
    return list;
  });

  let exitCode = 0;
  if (!Array.isArray(direct)) {
    console.error(`FAIL: fetchSituations returnerte ikke array: ${JSON.stringify(direct)}`);
    exitCode = 1;
  } else if (direct.length !== 1) {
    console.error(`FAIL: forventet 1 aktiv melding (utløpt skal filtreres bort), fikk ${direct.length}`);
    exitCode = 1;
  } else {
    const s = direct[0];
    if (s.summary !== "Innstilte tog Oslo–Drammen") {
      console.error(`FAIL: feil summary: ${s.summary}`);
      exitCode = 1;
    }
    if (!s.description.includes("Signalfeil")) {
      console.error(`FAIL: feil description: ${s.description}`);
      exitCode = 1;
    }
    if (s.severity !== "severe") {
      console.error(`FAIL: feil severity: ${s.severity}`);
      exitCode = 1;
    }
    if (s.advice !== "Bruk buss for tog.") {
      console.error(`FAIL: feil advice: ${s.advice}`);
      exitCode = 1;
    }
    if (exitCode === 0) console.log("[ok] fetchSituations parser korrekt og filtrerer utløpte");
  }

  console.log("[step] Åpne Oslo S og verifiser at popup viser avviket");
  const opened = await page.evaluate(() => {
    const layers = window.__app.state.stationLayer.getLayers();
    let best = null;
    let bestDist = Infinity;
    for (const l of layers) {
      const f = l.feature;
      if (!f || f.properties?.name !== "Oslo S") continue;
      const [lng, lat] = f.geometry.coordinates;
      const d = Math.hypot(lat - 59.9110, lng - 10.7531);
      if (d < bestDist) { bestDist = d; best = l; }
    }
    if (!best) return false;
    best.openPopup();
    return true;
  });

  if (!opened) {
    console.error("FAIL: fant ikke Oslo S i kartet");
    exitCode = 1;
  } else {
    await page.waitForSelector(".leaflet-popup-content .situations .sit-summary", { timeout: 10_000 }).catch(() => {});
    const sitText = await page.locator(".leaflet-popup-content .situations").innerText().catch(() => "");
    if (!/Innstilte tog/i.test(sitText)) {
      console.error(`FAIL: avvikstekst mangler i popup. Innhold: ${sitText.slice(0, 200)}`);
      exitCode = 1;
    } else {
      console.log("[ok] Popup viser avviket fra mock");
    }
    if (/Utløpt melding/.test(sitText)) {
      console.error("FAIL: utløpt melding ble vist i popup");
      exitCode = 1;
    }
  }

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
