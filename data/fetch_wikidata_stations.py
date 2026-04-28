"""Hent Wikidata-info for norske jernbanestasjoner.

Henter via Wikidata SPARQL Query Service:
  - alle Q-id-er klassifisert som railway station (Q55488 + subklasser) i Norge
  - fredningsstatus (P1435 heritage designation)
  - hovedbilde (P18 image)
  - åpningsår (P1619 date of official opening)
  - arkitekt (P84)
  - Riksantikvaren-ID (P5018) hvis satt
  - koordinat (P625)

Joiner deretter mot stations.geojson på navn + nærhet (≤500 m) og produserer
public/data/wikidata_stations.json — en lookup som frontend kan bruke i
stasjons-popup og stasjonsside.

Lisens: Wikidata-data er CC0; bilder fra Wikimedia Commons er CC-BY/CC-BY-SA.
Husk attribusjon ved visning.
"""

from __future__ import annotations

import json
import math
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
STATIONS_FILE = ROOT.parent / "public" / "data" / "stations.geojson"
OUTPUT_FILE = ROOT.parent / "public" / "data" / "wikidata_stations.json"

USER_AGENT = "norsk-jernbane-kart/0.1 (hobbyprosjekt; janarne84@gmail.com)"

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"

JOIN_RADIUS_M = 500  # romsligere enn Riksantikvaren — Wikidata-koordinatet
                    # er ofte for stasjons-tomten, ikke OSM-perrongen.

QUERY = """
SELECT ?station ?stationLabel ?coord ?heritage ?heritageLabel
       ?image ?opened ?architect ?architectLabel ?raId
WHERE {
  ?station (wdt:P31/wdt:P279*) wd:Q55488 .
  ?station wdt:P17 wd:Q20 .
  ?station wdt:P625 ?coord .
  OPTIONAL { ?station wdt:P1435 ?heritage . }
  OPTIONAL { ?station wdt:P18 ?image . }
  OPTIONAL { ?station wdt:P1619 ?opened . }
  OPTIONAL { ?station wdt:P84 ?architect . }
  OPTIONAL { ?station wdt:P5018 ?raId . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "nb,nn,en". }
}
"""


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_point(point_str: str) -> tuple[float, float] | None:
    """Wikidata Point format: 'Point(10.7531 59.9110)' (lon lat)."""
    m = re.match(r"Point\(([-\d.]+)\s+([-\d.]+)\)", point_str)
    if not m:
        return None
    return float(m.group(1)), float(m.group(2))


def fetch_wikidata() -> list[dict]:
    print("  → kjører SPARQL-spørring", file=sys.stderr)
    r = requests.get(
        WIKIDATA_SPARQL,
        params={"query": QUERY, "format": "json"},
        headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"},
        timeout=120,
    )
    r.raise_for_status()
    data = r.json()
    return data.get("results", {}).get("bindings", [])


def normalize(rows: list[dict]) -> dict[str, dict]:
    """Aggreger flere rader per stasjon (én rad per heritage/architect)."""
    by_qid: dict[str, dict] = {}
    for row in rows:
        qid_uri = row.get("station", {}).get("value", "")
        qid = qid_uri.rsplit("/", 1)[-1]
        if not qid:
            continue
        coord_str = row.get("coord", {}).get("value", "")
        coord = parse_point(coord_str)
        if not coord:
            continue
        lon, lat = coord

        entry = by_qid.setdefault(qid, {
            "qid": qid,
            "name": row.get("stationLabel", {}).get("value", ""),
            "lat": lat,
            "lon": lon,
            "heritage": [],
            "architects": [],
            "opened": None,
            "image": None,
            "ra_id": None,
        })

        h = row.get("heritageLabel", {}).get("value")
        if h and h not in entry["heritage"]:
            entry["heritage"].append(h)

        a = row.get("architectLabel", {}).get("value")
        if a and a not in entry["architects"]:
            entry["architects"].append(a)

        if not entry["image"]:
            img = row.get("image", {}).get("value")
            if img:
                entry["image"] = img

        if not entry["opened"]:
            op = row.get("opened", {}).get("value")
            if op:
                entry["opened"] = op[:10]  # ISO-date

        if not entry["ra_id"]:
            ra = row.get("raId", {}).get("value")
            if ra:
                entry["ra_id"] = ra

    return by_qid


def join_to_stations(wikidata: dict[str, dict], stations: dict) -> dict[str, dict]:
    """Match hver Wikidata-stasjon til en navngitt OSM-stasjon ved navn + nærhet."""
    osm_features = [
        f for f in stations.get("features", [])
        if f.get("properties", {}).get("name")
        and f.get("properties", {}).get("railway") in ("station", "halt")
    ]

    # Bygg navn-indeks for raskere oppslag.
    by_name: dict[str, list[dict]] = {}
    for f in osm_features:
        nm = f["properties"]["name"].lower().strip()
        by_name.setdefault(nm, []).append(f)

    result: dict[str, dict] = {}
    for qid, w in wikidata.items():
        wname = (w["name"] or "").lower().strip()
        candidates = by_name.get(wname, [])
        # Hvis ingen navnetreff, prøv kandidater med "X stasjon" / "X" -varianter.
        if not candidates and wname.endswith(" stasjon"):
            candidates = by_name.get(wname[:-len(" stasjon")], [])

        best = None
        best_d = float("inf")
        for f in candidates or osm_features:
            olon, olat = f["geometry"]["coordinates"]
            d = haversine_m(w["lat"], w["lon"], olat, olon)
            if d < best_d:
                best_d = d
                best = f
            # Tidlig exit hvis vi har et navnetreff på rimelig avstand.
            if candidates and best_d < JOIN_RADIUS_M:
                break

        if not best or best_d > JOIN_RADIUS_M:
            continue

        osm_name = best["properties"]["name"]
        existing = result.get(osm_name)
        # Hvis to Wikidata-treff matcher samme OSM-navn, foretrekk det med
        # mest data (heritage > image > opened).
        score = (
            len(w["heritage"]) * 10
            + (5 if w["image"] else 0)
            + (3 if w["opened"] else 0)
        )
        if existing and existing.get("_score", 0) >= score:
            continue

        result[osm_name] = {
            "qid": qid,
            "name": w["name"],
            "heritage": w["heritage"],
            "architects": w["architects"],
            "opened": w["opened"],
            "image": w["image"],
            "ra_id": w["ra_id"],
            "distance_m": round(best_d),
            "_score": score,
        }

    # Fjern intern _score
    for v in result.values():
        v.pop("_score", None)

    return result


def main() -> int:
    if not STATIONS_FILE.exists():
        print(f"Mangler {STATIONS_FILE} — kjør process.py først.", file=sys.stderr)
        return 1

    print("Henter Wikidata-stasjoner via SPARQL…")
    try:
        rows = fetch_wikidata()
    except requests.RequestException as exc:
        print(f"Feil ved SPARQL: {exc}", file=sys.stderr)
        return 2
    print(f"  fikk {len(rows)} rader fra Wikidata")

    wikidata = normalize(rows)
    print(f"  unike stasjoner: {len(wikidata)}")

    stations = json.loads(STATIONS_FILE.read_text(encoding="utf-8"))
    matched = join_to_stations(wikidata, stations)
    with_heritage = sum(1 for v in matched.values() if v.get("heritage"))
    with_image = sum(1 for v in matched.values() if v.get("image"))
    print(f"  joinet {len(matched)} OSM-stasjoner ({with_heritage} med vernestatus, {with_image} med bilde)")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(matched, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    size_kb = OUTPUT_FILE.stat().st_size / 1024
    print(f"Skrev {OUTPUT_FILE.name}: {size_kb:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
