#!/usr/bin/env node
// Test-runner som kjører Playwright-testene i kategorier.
//
// Bruk:
//   node scripts/run-tests.mjs           # CI-trygge tester (no live API)
//   node scripts/run-tests.mjs --all     # alle tester (krever live Entur)
//   node scripts/run-tests.mjs --local   # alle som ikke krever Entur
//
// Hver test er et frittstående node-skript som leser BASE_URL fra env og
// avslutter med exit-kode 0/1. Vi kjører dem sekvensielt — Playwright bruker
// én Chromium per test, og parallell-kjøring uten Playwright Test runner
// skaper for mye ressursbruk.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// CI-trygge: kan kjøres uten Entur eller andre live APIer.
const CI_TESTS = [
  "tests/slugify-parity.test.js",
  "tests/binning-parity.test.js",
  "tests/overview-loading.test.js",
  "tests/filter.test.js",
  "tests/dashboard.test.js",
  "tests/live-trains-snap.test.js",  // mocker fetchVehicles
];

// Krever ikke Entur, men er mer ressurskrevende eller dekker UI-detaljer
// som ikke endrer seg ofte. Kjøres som del av --local og --all.
const LOCAL_TESTS = [
  "tests/route.test.js",
  "tests/route-perf.test.js",
  "tests/stations.test.js",
  "tests/mobile-nav.test.js",
  "tests/onepager-quick.test.js",
  "tests/planovergang-page.test.js",
  "tests/dropdown-keyboard.test.js",
  "tests/uniformity.test.js",
  "tests/pro.test.js",
];

// Krever live Entur GraphQL. Kjøres KUN under --all.
const ENTUR_TESTS = [
  "tests/entur.test.js",
  "tests/entur-retry.test.js",
  "tests/entur-situations.test.js",
  "tests/live-trains.test.js",
  "tests/live-trains-lerp.test.js",
  "tests/tog-page.test.js",
  "tests/station-page.test.js",   // bruker Entur for avganger
];

const args = process.argv.slice(2);
const mode = args.includes("--all") ? "all"
            : args.includes("--local") ? "local"
            : "ci";

const tests =
  mode === "all"   ? [...CI_TESTS, ...LOCAL_TESTS, ...ENTUR_TESTS]
: mode === "local" ? [...CI_TESTS, ...LOCAL_TESTS]
:                    CI_TESTS;

console.log(`[test-runner] kjører ${tests.length} tester i mode=${mode}`);
console.log(`[test-runner] BASE_URL=${process.env.BASE_URL || "http://localhost:5174"}`);

let failed = 0;
const failures = [];
const t0 = Date.now();

for (const t of tests) {
  if (!existsSync(t)) {
    console.error(`[skip] ${t} finnes ikke`);
    continue;
  }
  console.log(`\n── ${t} ──`);
  const r = spawnSync("node", [t], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    failed += 1;
    failures.push(t);
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n[test-runner] ferdig på ${elapsed}s. ${tests.length - failed}/${tests.length} OK.`);
if (failures.length) {
  console.error(`[test-runner] feilet: ${failures.join(", ")}`);
}
process.exit(failed === 0 ? 0 : 1);
