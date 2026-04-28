// Verifiserer at slugify() i public/helpers.js gir samme resultat som
// slugify() i data/process.py. Hvis disse divergerer skriver Python filer
// som JS aldri finner — derfor er paritet kritisk.

import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

const SAMPLES = [
  "Bergensbanen",
  "Røros-banen",
  "Sørlandsbanen",
  "Ofotbanen",
  "Gjøvikbanen",
  "Drammen–Skien",
  "Halden – Gøteborg",
  "  whitespace ",
  "Æ Ø Å",
  "Linje 1",
];

function pythonSlugs() {
  const code = `
import sys
sys.path.insert(0, "data")
from process import slugify
import json
import sys
samples = ${JSON.stringify(SAMPLES)}
print(json.dumps([slugify(s) for s in samples]))
`;
  const res = spawnSync(".venv/Scripts/python.exe", ["-c", code], {
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`python slugify feilet: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

async function jsSlugs() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}/bane.html?navn=Bergensbanen`);
  await page.waitForFunction(() => window.AppHelpers?.slugify, { timeout: 5000 });
  const out = await page.evaluate((s) => s.map((x) => window.AppHelpers.slugify(x)), SAMPLES);
  await browser.close();
  return out;
}

async function run() {
  const py = pythonSlugs();
  const js = await jsSlugs();
  const results = [];
  for (let i = 0; i < SAMPLES.length; i++) {
    const ok = py[i] === js[i];
    results.push({ ok, name: `slugify(${JSON.stringify(SAMPLES[i])})`, py: py[i], js: js[i] });
  }
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== OPPSUMMERING ===");
  if (fails.length === 0) {
    console.log(`Alt OK (${results.length} samples).`);
    process.exit(0);
  }
  for (const r of fails) {
    console.log(`  ✗ ${r.name}: py=${JSON.stringify(r.py)} js=${JSON.stringify(r.js)}`);
  }
  process.exit(1);
}

run().catch((e) => {
  console.error("Uventet feil:", e);
  process.exit(2);
});
