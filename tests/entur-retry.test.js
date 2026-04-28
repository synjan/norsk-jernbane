// Verifiser at bane.js viser «Prøv igjen»-knapp når Entur feiler.
// Bruker route-interception for å feile alle requests mot Entur.

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";
const findings = [];

function note(level, msg) {
  const line = `[${level}] ${msg}`;
  findings.push(line);
  console.log(line);
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // Blokker Entur-trafikk så vi tvinger feilstien.
  await page.route("**/api.entur.io/**", (route) => route.abort());

  // Tøm localStorage-cache slik at findStopPlace virkelig prøver å fetche.
  await page.goto(`${BASE_URL}/bane.html?navn=Bergensbanen`);
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("entur:"))
      .forEach((k) => localStorage.removeItem(k));
  });
  await page.reload();
  await page.waitForFunction(() => window.__route?.ready === true);
  await page.waitForTimeout(400);

  note("step", "Klikker første stasjon");
  const heads = await page.locator(".station-head").all();
  if (heads.length === 0) { note("fail", "Ingen stasjoner"); process.exit(1); }
  await heads[0].click();

  // Vent på retry-knapp innen 12 s (8 s timeout + buffer)
  try {
    await page.locator(".departures-slot button").first().waitFor({ timeout: 12_000 });
    note("ok", "«Prøv igjen»-knapp dukket opp");
  } catch {
    const slotText = await page.locator(".departures-slot").first().textContent();
    note("fail", `Ingen retry-knapp innen 12s. Slot-tekst: «${slotText?.slice(0, 120)}»`);
    process.exit(1);
  }

  // Sjekk at det finnes en feiltekst-streng i samme slot
  const slotText = await page.evaluate(() => {
    const slots = document.querySelectorAll(".departures-slot");
    for (const slot of slots) {
      if (slot.style.display !== "none") return slot.textContent;
    }
    return "";
  });
  note("info", `Slot etter feil: ${slotText?.slice(0, 120)}`);
  if (!/Kunne ikke|tok for lang tid/i.test(slotText || "")) {
    note("fail", "Mangler feiltekst i slot");
  }

  // Klikk retry — den skal også feile, men knappen må re-vises
  note("step", "Klikker «Prøv igjen»");
  await page.locator(".departures-slot button").first().click();
  await page.locator(".departures-slot button").first().waitFor({ timeout: 12_000 });
  note("ok", "Retry-knapp re-vises etter andre feil");

  await browser.close();

  console.log("\n=== OPPSUMMERING ===");
  const fails = findings.filter((l) => l.startsWith("[fail]"));
  if (fails.length) { fails.forEach((f) => console.log("  " + f)); process.exit(1); }
  console.log("Alt OK.");
}

run().catch((e) => { console.error(e); process.exit(1); });
