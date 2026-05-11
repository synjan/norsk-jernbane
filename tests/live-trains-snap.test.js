// Verifiserer at live tog snapper til skinnegangen i stedet for å LERPe
// rett over fjord/fjell.
//
// Strategi: mock window.Entur.fetchVehicles med to syntetiske tog:
//   1. Plassert ~10 m fra en faktisk railway-koordinat → entry.snap skal settes
//   2. Plassert midt i Nordsjøen → entry.snap skal være null (fallback til LERP)
//
// Vi sjekker at:
//   - state.railwayIndex bygges når live tog skrus på
//   - første tog får en snap-path med arc-length > 0
//   - andre tog har snap === null
//   - markøren for det første toget ligger nær en railway-koordinat etter en
//     animasjonsramme (innen snap-toleransen + LERP-margin)

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

  console.log(`[step] Åpner ${BASE_URL}`);
  await page.goto(BASE_URL);
  await page.waitForFunction(() => Boolean(window.__app?.state?.stationLayer));

  // Tving lasting av full railways.geojson nå, så snap-indeksen kan bygges
  // synkront når vi aktiverer live tog. (setLiveTrains gjør det også, men
  // vi vil ha forutsigbar timing.)
  console.log("[step] Last full railways.geojson");
  await page.evaluate(() => window.__app.map.setZoom(11));
  await page.waitForFunction(() => window.__app.state.railwaysIsFull === true, { timeout: 15_000 });

  // Plukk ut en faktisk railway-koordinat å plassere mock-toget på.
  const railSample = await page.evaluate(() => {
    const features = window.__app.state.railwaysData.features;
    // Velg et segment som har minst 5 punkter (gir oss en path å kjøre langs).
    for (const f of features) {
      const c = f.geometry.coordinates;
      if (c.length >= 5) {
        const mid = Math.floor(c.length / 2);
        return {
          fromLon: c[mid - 1][0],   fromLat: c[mid - 1][1],
          toLon:   c[mid + 1][0],   toLat:   c[mid + 1][1],
        };
      }
    }
    return null;
  });
  if (!railSample) {
    console.error("FAIL: fant ikke et segment med >=5 punkter");
    process.exit(1);
  }
  console.log(`[info] Mock-tog ved (${railSample.fromLat.toFixed(4)}, ${railSample.fromLon.toFixed(4)})`);

  // Mock fetchVehicles før vi krysser av live-tog-boksen. Begge tog har
  // fersk lastUpdated så de ikke filtreres ut.
  await page.evaluate((sample) => {
    const now = new Date().toISOString();
    const TRAINS = [
      {
        datedServiceJourney: { id: "TEST-RAIL" },
        location: { latitude: sample.fromLat + 0.00005, longitude: sample.fromLon + 0.00005 },
        lastUpdated: now,
        line: { publicCode: "T1", lineName: "Snap-test" },
        bearing: 0,
      },
      {
        datedServiceJourney: { id: "TEST-OCEAN" },
        location: { latitude: 58.0, longitude: 2.5 },  // midt i Nordsjøen
        lastUpdated: now,
        line: { publicCode: "T2", lineName: "Ocean-test" },
        bearing: 0,
      },
    ];
    window.Entur = window.Entur || {};
    // Andre poll skal flytte rail-toget et stykke fremover — gir oss en
    // tween-bevegelse å observere.
    let pollCount = 0;
    window.Entur.fetchVehicles = async () => {
      pollCount += 1;
      if (pollCount >= 2) {
        TRAINS[0].location = {
          latitude: sample.toLat + 0.00005,
          longitude: sample.toLon + 0.00005,
        };
        TRAINS[0].lastUpdated = new Date().toISOString();
      }
      return TRAINS;
    };
  }, railSample);

  console.log("[step] Skru på Live tog");
  await page.evaluate(() => {
    document.querySelectorAll("details").forEach((d) => { d.open = true; });
  });
  await page.locator("#show-live-trains").check();
  await page.waitForFunction(
    () => window.__app?.state?.liveTrainsLastUpdate != null,
    { timeout: 15_000 }
  );

  // 1) Snap-index bygget?
  const indexBuilt = await page.evaluate(() => Boolean(window.__app.state.railwayIndex));
  console.log(`[check] railwayIndex bygget: ${indexBuilt}`);
  if (!indexBuilt) {
    console.error("FAIL: state.railwayIndex ble ikke bygget etter setLiveTrains(true)");
    process.exit(1);
  }

  // 2) Tog #1 (på spor) har snap, tog #2 (i havet) har det ikke.
  // Etter første poll har from === to, og snap settes uansett (kort path)
  // — vi bryr oss om at PATH-STRUKTUREN er bygget for rail-toget, ikke for
  // ocean-toget.
  const initialState = await page.evaluate(() => {
    const trains = window.__app.state.liveTrainsTrains;
    if (!trains) return null;
    const out = {};
    for (const [id, e] of trains) {
      out[id] = {
        hasSnap: Array.isArray(e.snap) && e.snap.length > 0,
        snapLen: e.snap?.length || 0,
      };
    }
    return out;
  });
  console.log(`[info] etter første poll: ${JSON.stringify(initialState)}`);
  // På første poll er from === to, så cumDistM = 0. Vi sjekker derfor først
  // etter ANDRE poll (når from != to).

  // 3) Vent på andre poll — da skal rail-toget faktisk få en bevegelses-path
  console.log("[step] Vent på andre poll (~15 sek)…");
  const firstUpdate = await page.evaluate(() => window.__app.state.liveTrainsLastUpdate);
  await page.waitForFunction(
    (ts) => {
      const cur = window.__app?.state?.liveTrainsLastUpdate;
      return cur != null && cur > ts;
    },
    firstUpdate,
    { timeout: 25_000 }
  );

  const snapState = await page.evaluate(() => {
    const trains = window.__app.state.liveTrainsTrains;
    if (!trains) return null;
    const out = {};
    for (const [id, e] of trains) {
      out[id] = {
        snapLen: e.snap?.length || 0,
        totalDist: e.snap ? e.snap[e.snap.length - 1].cumDistM : null,
      };
    }
    return out;
  });
  console.log(`[info] etter andre poll: ${JSON.stringify(snapState)}`);

  let exitCode = 0;
  if (!snapState || !snapState["TEST-RAIL"] || snapState["TEST-RAIL"].snapLen < 2) {
    console.error("FAIL: TEST-RAIL skulle ha snap-path med ≥2 punkter etter andre poll");
    exitCode = 1;
  } else if (snapState["TEST-RAIL"].totalDist <= 0) {
    console.error("FAIL: TEST-RAIL skulle ha en bevegelses-distanse > 0");
    exitCode = 1;
  } else {
    console.log(`[ok] TEST-RAIL har snap-path med ${snapState["TEST-RAIL"].snapLen} punkter og ${snapState["TEST-RAIL"].totalDist.toFixed(1)} m bevegelse`);
  }

  if (snapState && snapState["TEST-OCEAN"] && snapState["TEST-OCEAN"].snapLen > 0) {
    console.error("FAIL: TEST-OCEAN burde IKKE ha snap (ingen spor i Nordsjøen)");
    exitCode = 1;
  } else {
    console.log("[ok] TEST-OCEAN har snap === null (fallback til LERP)");
  }

  // 4) Verifiser at markøren faktisk beveger seg langs banen, ikke i rett linje.
  // Vent litt inn i tween-en og sjekk at markøren ligger nær én av path-punktene.
  await page.waitForTimeout(2000);
  const markerCheck = await page.evaluate(() => {
    const e = window.__app.state.liveTrainsTrains.get("TEST-RAIL");
    if (!e || !e.snap) return null;
    const ll = e.marker.getLatLng();
    // Avstand til nærmeste path-punkt — fra arc-length-interpoleringen skal
    // markøren alltid ligge på path-segmentene, så avstanden er ~0.
    let minDist = Infinity;
    for (let i = 0; i < e.snap.length - 1; i++) {
      const a = e.snap[i], b = e.snap[i + 1];
      // Avstand fra ll til segment (a,b) — enkel projeksjon
      const ax = a.lon, ay = a.lat, bx = b.lon, by = b.lat;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx*dx + dy*dy;
      let t = len2 > 0 ? Math.max(0, Math.min(1, ((ll.lng-ax)*dx + (ll.lat-ay)*dy) / len2)) : 0;
      const sx = ax + t*dx, sy = ay + t*dy;
      const ddx = ll.lng - sx, ddy = ll.lat - sy;
      const distDeg = Math.hypot(ddx, ddy);
      if (distDeg < minDist) minDist = distDeg;
    }
    // Konverter til meter (grov, men greit for nær-test): 1° lat ≈ 111 km
    return { minDistM: minDist * 111000, markerPos: [ll.lat, ll.lng] };
  });
  if (markerCheck) {
    console.log(`[info] markør ${markerCheck.minDistM.toFixed(2)} m fra nærmeste path-segment`);
    if (markerCheck.minDistM > 5) {
      // 5 m tolerance er romslig for flytetalls-rundinger; arc-length-interp
      // skulle gi essentielt 0 m
      console.error(`FAIL: markøren skulle ligge på snap-path, men ligger ${markerCheck.minDistM.toFixed(2)} m unna`);
      exitCode = 1;
    } else {
      console.log("[ok] markør følger snap-path");
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
