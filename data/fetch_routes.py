"""Hent OSM `route=train`-relasjoner for Norge fra Overpass.

Kjøres som tilleggssteg etter fetch.py / process.py. Lagrer
public/data/routes_osm.json — en lookup med rute-metadata og hvilke
stasjoner ruten passerer (basert på `stop`-medlemmer i relasjonen).

Output:
  {
    "Bergensbanen": {
      "name": "Bergensbanen",
      "ref": null,
      "operator": "Bane NOR",
      "stations": ["Oslo S", "Hønefoss", ...]
    },
    ...
  }

Kombinert med stations.geojson lager det en station→routes-lookup
som frontend kan bruke for "ruter som stopper her" på stasjonssiden.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
OUTPUT_FILE = ROOT.parent / "public" / "data" / "routes_osm.json"
STATION_LOOKUP_FILE = ROOT.parent / "public" / "data" / "station_routes.json"
STATIONS_FILE = ROOT.parent / "public" / "data" / "stations.geojson"

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
USER_AGENT = "norsk-jernbane-kart/0.1 (hobbyprosjekt; janarne84@gmail.com)"

QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="NO"][admin_level=2]->.norge;
rel["route"="train"](area.norge)->.routes;
.routes out body;
node(r.routes:"stop")->.stops;
node(r.routes:"stop_entry_only")->.entry;
node(r.routes:"stop_exit_only")->.exit;
(.stops; .entry; .exit;)->.allstops;
.allstops out body;
"""


def fetch() -> dict:
    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        print(f"  → prøver {endpoint}", file=sys.stderr)
        try:
            r = requests.post(
                endpoint,
                data={"data": QUERY},
                headers={"User-Agent": USER_AGENT},
                timeout=240,
            )
            r.raise_for_status()
            return r.json()
        except requests.RequestException as exc:
            last_err = exc
            print(f"    feil: {exc}", file=sys.stderr)
            time.sleep(2)
    raise RuntimeError(f"Alle Overpass-instanser feilet: {last_err}")


def index_nodes(elements: list[dict]) -> dict[int, dict]:
    """Indeks fra node-id til {name, lat, lon} for stop-medlemmer."""
    nodes: dict[int, dict] = {}
    for el in elements:
        if el.get("type") == "node":
            nodes[el["id"]] = {
                "name": (el.get("tags") or {}).get("name"),
                "lat": el.get("lat"),
                "lon": el.get("lon"),
            }
    return nodes


def extract_routes(elements: list[dict], nodes: dict[int, dict]) -> dict[str, dict]:
    """Plukk ut metadata + stop-medlemmer fra hver route-relasjon."""
    routes: dict[str, dict] = {}
    for el in elements:
        if el.get("type") != "relation":
            continue
        tags = el.get("tags") or {}
        if tags.get("route") != "train":
            continue
        name = tags.get("name") or tags.get("ref") or f"route-{el['id']}"

        stops: list[str] = []
        for m in el.get("members") or []:
            if m.get("type") != "node":
                continue
            role = (m.get("role") or "").lower()
            if "stop" not in role:  # "stop", "stop_entry_only" etc.
                continue
            n = nodes.get(m.get("ref"))
            if n and n.get("name"):
                if n["name"] not in stops:
                    stops.append(n["name"])

        # Slå sammen ved navne-kollisjon (f.eks. flere relasjoner per linje).
        existing = routes.get(name)
        if existing:
            for s in stops:
                if s not in existing["stations"]:
                    existing["stations"].append(s)
            continue

        routes[name] = {
            "id": el["id"],
            "name": name,
            "ref": tags.get("ref"),
            "operator": tags.get("operator"),
            "network": tags.get("network"),
            "from": tags.get("from"),
            "to": tags.get("to"),
            "stations": stops,
        }
    return routes


def build_station_lookup(routes: dict[str, dict]) -> dict[str, list[dict]]:
    """Inverter routes så vi får stasjonsnavn → liste over ruter som stopper."""
    by_station: dict[str, list[dict]] = {}
    for name, r in routes.items():
        for st in r["stations"]:
            by_station.setdefault(st, []).append({
                "name": name,
                "ref": r.get("ref"),
                "operator": r.get("operator"),
            })
    return by_station


def main() -> int:
    print("Henter route=train relasjoner fra Overpass…")
    data = fetch()
    elements = data.get("elements", [])
    print(f"  fikk {len(elements)} elementer")

    nodes = index_nodes(elements)
    routes = extract_routes(elements, nodes)
    print(f"  parset {len(routes)} unike togruter")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(routes, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Skrev {OUTPUT_FILE.name}: {OUTPUT_FILE.stat().st_size / 1024:.1f} KB")

    station_lookup = build_station_lookup(routes)
    STATION_LOOKUP_FILE.write_text(
        json.dumps(station_lookup, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Skrev {STATION_LOOKUP_FILE.name}: {STATION_LOOKUP_FILE.stat().st_size / 1024:.1f} KB ({len(station_lookup)} stasjoner)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
