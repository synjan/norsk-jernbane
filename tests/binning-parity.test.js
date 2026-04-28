// Verifiserer at bucket_speed, bucket_track og co2_estimate_tonnes_per_year
// gir IDENTISK resultat i data/process.py og public/helpers.js. Hvis disse
// divergerer vil kart-siden (filtrert) og dashbord/Python-aggregert (u-filtrert)
// vise ulike tall for samme datasett — og brukeren kan ikke stole på kartet.

import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

const SPEED_CASES = [
  [null, null],
  [null, "siding"],
  [0, null],
  [50, null],
  [79, null],
  [80, null],
  [129, null],
  [130, null],
  [159, null],
  [160, null],
  [199, null],
  [200, null],
  [250, null],
  [120, "passenger"],
  [120, "siding"],
  [120, "yard"],
  [120, "spur"],
  [120, "crossover"],
];

const TRACK_CASES = [
  [null, null],
  ["", null],
  ["0", null],
  ["1", null],
  ["2", null],
  ["3", null],
  ["10", null],
  ["abc", null],
  ["2", "siding"],
  ["2", "yard"],
];

const CO2_CASES = [0, 50.5, 100, 1850.7, 5000];

function pythonRun() {
  // JSON-strenger sendes inn som tekst og parses med json.loads inne i
  // Python — ellers tolkes `null` som Python-identifikator.
  const code = `
import sys, json
sys.path.insert(0, "data")
from process import bucket_speed, bucket_track, co2_estimate_tonnes_per_year

speed = json.loads('''${JSON.stringify(SPEED_CASES)}''')
track = json.loads('''${JSON.stringify(TRACK_CASES)}''')
co2 = json.loads('''${JSON.stringify(CO2_CASES)}''')

print(json.dumps({
  "speed": [bucket_speed(s, sv) for s, sv in speed],
  "track": [bucket_track(p, sv) for p, sv in track],
  "co2": [co2_estimate_tonnes_per_year(km) for km in co2],
}))
`;
  const res = spawnSync(".venv/Scripts/python.exe", ["-c", code], {
    encoding: "utf-8",
  });
  if (res.status !== 0) throw new Error(`python feilet: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

async function jsRun() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}/bane.html?navn=Bergensbanen`);
  await page.waitForFunction(() => window.AppHelpers?.bucketSpeed, { timeout: 5000 });
  const out = await page.evaluate(({ speed, track, co2 }) => {
    const h = window.AppHelpers;
    return {
      speed: speed.map(([s, sv]) => h.bucketSpeed(s, sv)),
      track: track.map(([p, sv]) => h.bucketTrack(p, sv)),
      co2: co2.map((km) => h.co2EstimateTonnesPerYear(km)),
    };
  }, { speed: SPEED_CASES, track: TRACK_CASES, co2: CO2_CASES });
  await browser.close();
  return out;
}

function compareGroup(name, cases, py, js) {
  const fails = [];
  for (let i = 0; i < cases.length; i++) {
    if (py[i] !== js[i]) {
      fails.push(`  ✗ ${name}(${JSON.stringify(cases[i])}): py=${JSON.stringify(py[i])} js=${JSON.stringify(js[i])}`);
    }
  }
  return fails;
}

async function run() {
  const py = pythonRun();
  const js = await jsRun();

  const fails = [
    ...compareGroup("bucketSpeed", SPEED_CASES, py.speed, js.speed),
    ...compareGroup("bucketTrack", TRACK_CASES, py.track, js.track),
    ...compareGroup("co2EstimateTonnesPerYear", CO2_CASES, py.co2, js.co2),
  ];

  console.log("\n=== OPPSUMMERING ===");
  if (fails.length === 0) {
    const total = SPEED_CASES.length + TRACK_CASES.length + CO2_CASES.length;
    console.log(`Alt OK (${total} samples på tvers av Python og JS).`);
    process.exit(0);
  }
  for (const f of fails) console.log(f);
  console.log(`${fails.length} avvik mellom Python og JS.`);
  process.exit(1);
}

run().catch((e) => {
  console.error("Uventet feil:", e);
  process.exit(2);
});
