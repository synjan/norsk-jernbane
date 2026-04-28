"""Hent jernbanekryssinger (planoverganger) fra NVDB API.

NVDB objekttype 100 = "Jernbanekryssing" — sted i vegnettet hvor veg og
jernbane krysses (i plan eller plan-forskjell). Henter alle og lagrer
public/data/planoverganger.geojson som frontend toggler i kart-laget.

Lisens: NLOD 2.0 (Statens vegvesen NVDB).
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
OUTPUT_FILE = ROOT.parent / "public" / "data" / "planoverganger.geojson"

NVDB_BASE = "https://nvdbapiles.atlas.vegvesen.no/vegobjekter/100"
USER_AGENT = "norsk-jernbane-kart/0.1 (hobbyprosjekt; janarne84@gmail.com)"

# WKT POINT Z parses to lon/lat — NVDB v4 returnerer SRID 4326 ved
# srid=4326-parameter. Z-koordinaten (høyde) ignoreres.
WKT_RE = re.compile(r"POINT(?:\s*Z)?\s*\(([-\d.]+)\s+([-\d.]+)(?:\s+[-\d.]+)?\)")


def parse_point(wkt: str) -> tuple[float, float] | None:
    m = WKT_RE.match(wkt or "")
    if not m:
        return None
    # WKT er (X Y) — med srid=4326 er X=lon, Y=lat. NB: Noen NVDB-svar
    # leverer (lat lon) i 4326; vi heuristikk-sjekker mot Norge-bbox.
    a, b = float(m.group(1)), float(m.group(2))
    # Norge: lat 57–72, lon 4–32. Hvis a er i lat-rangen og b er i lon-rangen,
    # er rekkefølgen (lat, lon) og vi snur.
    if 57 <= a <= 72 and 4 <= b <= 32:
        return b, a  # (lon, lat)
    return a, b      # (lon, lat)


def egenskap(obj: dict, key: str) -> str | None:
    """Plukk egenskap-verdi etter navn."""
    for e in obj.get("egenskaper", []) or []:
        if e.get("navn") == key:
            v = e.get("verdi")
            return str(v) if v is not None else None
    return None


def fetch_all() -> list[dict]:
    objects: list[dict] = []
    url = f"{NVDB_BASE}?srid=4326&inkluder=geometri,egenskaper&antall=1000"
    page = 0

    while url:
        page += 1
        print(f"  → side {page}", file=sys.stderr)
        r = requests.get(url, headers={"X-Client": "norsk-jernbane-kart"}, timeout=60)
        r.raise_for_status()
        data = r.json()
        chunk = data.get("objekter", []) or []
        objects.extend(chunk)
        nxt = data.get("metadata", {}).get("neste", {})
        url = nxt.get("href") if chunk else None
        time.sleep(0.3)  # vær snill

    return objects


def to_geojson(objects: list[dict]) -> dict:
    features = []
    skipped = 0
    for o in objects:
        wkt = (o.get("geometri") or {}).get("wkt", "")
        coord = parse_point(wkt)
        if not coord:
            skipped += 1
            continue
        lon, lat = coord
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "id": o.get("id"),
                "type": egenskap(o, "Type"),
                "tilleggsinfo": egenskap(o, "Tilleggsinformasjon"),
                "fare": egenskap(o, "Særskilt fare"),
            },
        })
    if skipped:
        print(f"  hoppet over {skipped} objekter uten gyldig POINT-geometri", file=sys.stderr)
    return {"type": "FeatureCollection", "features": features}


def main() -> int:
    print("Henter jernbanekryssinger fra NVDB…")
    try:
        objs = fetch_all()
    except requests.RequestException as exc:
        print(f"NVDB-feil: {exc}", file=sys.stderr)
        return 2
    print(f"Totalt {len(objs)} jernbanekryssinger")

    fc = to_geojson(objs)
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    size_kb = OUTPUT_FILE.stat().st_size / 1024
    print(f"Skrev {OUTPUT_FILE.name}: {size_kb:.1f} KB ({len(fc['features'])} punkter)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
