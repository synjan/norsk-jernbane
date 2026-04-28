"""Konverter rå Overpass-JSON til GeoJSON-lag og statistikk.

Leser `data/raw.json` og produserer:
  - `public/data/railways.geojson`  (LineString-features per spor)
  - `public/data/stations.geojson`  (Point-features per stasjon)
  - `public/data/stats.json`        (aggregert statistikk)
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import osm2geojson
from pyproj import Transformer
from shapely.geometry import LineString, shape

ROOT = Path(__file__).resolve().parent
RAW_FILE = ROOT / "raw.json"
PLACES_FILE = ROOT / "places.json"
OUTPUT_DIR = ROOT.parent / "public" / "data"

# Prosjektet er fokusert på "ekte" jernbane/tog. T-bane, trikk, bybane,
# kabelbane og monorail er ikke "tog" i daglig forstand og filtreres bort.
# Smalspor og museumsbaner er fortsatt tog (Setesdalsbanen, Krøderbanen, …).
ALLOWED_RAILWAY_TYPES = {"rail", "narrow_gauge", "preserved"}
ALLOWED_STATION_TYPES = {"station", "halt", "stop"}

# UTM 33N — egnet for Norge, gir avstand i meter.
TO_UTM33 = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)

# Hvilke tags vi tar med videre til GeoJSON-en (resten kastes for å holde filen liten).
RAILWAY_TAGS = {
    "railway", "name", "ref", "operator", "usage", "service",
    "electrified", "voltage", "frequency", "maxspeed", "gauge",
    "tracks", "tunnel", "bridge",
    # passenger_lines er bedre dekket i OSM-Norge enn `tracks` (~59% vs 0.2%)
    # og brukes som proxy for enkelt-/dobbeltspor.
    "passenger_lines",
}
STATION_TAGS = {
    "railway", "name", "ref", "operator", "uic_ref", "uic_name",
    "network", "subway",
}


def project_length_km(line: LineString) -> float:
    """Lengde av en LineString i kilometer, projisert til UTM33N."""
    coords = [TO_UTM33.transform(x, y) for x, y in line.coords]
    return LineString(coords).length / 1000.0


def parse_speed_kmh(raw: str | None) -> float | None:
    """Tolk OSM `maxspeed`-tag. Kan være '120', '120 mph', 'walk', 'none'."""
    if not raw:
        return None
    raw = raw.strip().lower()
    if raw in {"none", "walk", "signals"}:
        return None
    match = re.match(r"(\d+(?:\.\d+)?)\s*(mph|knots)?", raw)
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2)
    if unit == "mph":
        return value * 1.609344
    if unit == "knots":
        return value * 1.852
    return value  # km/h


def slim_properties(props: dict, allowed: set[str]) -> dict:
    """Behold kun tags vi bryr oss om, drop tomme."""
    return {k: v for k, v in props.items() if k in allowed and v not in (None, "")}


# Bøtte- og CO₂-helpers — speilet i public/helpers.js. Paritet håndheves
# av tests/binning-parity.test.js. Endrer du tall/grenser her, oppdater
# helpers.js samtidig.

EXCLUDED_SERVICE = frozenset({"siding", "yard", "spur", "crossover"})


def parse_passenger_lines(raw: Any) -> int | None:
    """OSM `passenger_lines` er gjerne '1', '2', '4'…  None for ikke tagget."""
    if raw in (None, ""):
        return None
    try:
        return int(str(raw).strip())
    except ValueError:
        return None

CO2_ASSUMPTIONS = {
    "trains_per_day": 10,
    "gross_tonnes": 250,
    "days": 365,
    "kg_per_gtk": 0.05,
}
CO2_ASSUMPTION_TEXT = (
    f"{CO2_ASSUMPTIONS['trains_per_day']} tog/døgn × "
    f"{CO2_ASSUMPTIONS['gross_tonnes']} t × "
    f"{CO2_ASSUMPTIONS['kg_per_gtk']} kg CO₂/GTK"
)


def bucket_speed(speed: float | None, service: str | None) -> str | None:
    """Bøttenavn for hastighet, eller None hvis service-tag tilsier eksklusjon."""
    if service in EXCLUDED_SERVICE:
        return None
    if speed is None:
        return "Ukjent"
    if speed < 80:
        return "<80"
    if speed < 130:
        return "80–130"
    if speed < 160:
        return "130–160"
    if speed < 200:
        return "160–200"
    return "200+"


def bucket_track(passenger_lines_raw: Any, service: str | None) -> str | None:
    """Bøttenavn for sporkapasitet, eller None hvis ekskludert."""
    if service in EXCLUDED_SERVICE:
        return None
    n = parse_passenger_lines(passenger_lines_raw)
    if n is None:
        return "Ikke tagget"
    if n <= 1:
        return "Enkeltspor"
    if n == 2:
        return "Dobbeltspor"
    return "Multispor (3+)"


def co2_estimate_tonnes_per_year(non_electrified_km: float) -> int:
    """Tonn CO₂ per år for ikke-elektrifiserte strekninger.

    Bruker `int(x + 0.5)` (round-half-up) i stedet for `round()` (banker's
    rounding) for å matche JS' Math.round — ellers oppstår 1-tonns avvik
    ved nøyaktig .5-verdier (f.eks. 100 km gir 4562.5 → 4562 vs 4563)."""
    c = CO2_ASSUMPTIONS
    val = (non_electrified_km * c["trains_per_day"] * c["gross_tonnes"]
           * c["days"] * c["kg_per_gtk"] / 1000)
    return int(val + 0.5) if val >= 0 else -int(-val + 0.5)


def slugify(name: str) -> str:
    """URL-trygt filnavn fra rute-navn. Speiler `slugify()` i public/helpers.js
    — vær forsiktig hvis du endrer denne, begge må stemme."""
    s = name.lower().strip()
    s = s.replace("æ", "ae").replace("ø", "o").replace("å", "a")
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"[^a-z0-9\-]", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "uten-navn"


def split_features(features: Iterable[dict]) -> tuple[list[dict], list[dict]]:
    railways, stations = [], []
    for feat in features:
        geom = feat.get("geometry")
        props = feat.get("properties") or {}
        tags = props.get("tags") or {}
        if not geom:
            continue
        gtype = geom["type"]

        if gtype == "LineString" and tags.get("railway") in ALLOWED_RAILWAY_TYPES:
            line = shape(geom)
            length_km = project_length_km(line)
            speed = parse_speed_kmh(tags.get("maxspeed"))
            slim = slim_properties(tags, RAILWAY_TAGS)
            slim["length_km"] = round(length_km, 3)
            if speed is not None:
                slim["maxspeed_kmh"] = round(speed, 1)
            railways.append({
                "type": "Feature",
                "geometry": geom,
                "properties": slim,
            })
        elif gtype == "Point" and tags.get("railway") in ALLOWED_STATION_TYPES:
            # Mange OSM-noder er tagget railway=stop|station men er egentlig
            # T-bane/trikk/bybane-stopp via egne mode-tags. Filtrer dem bort
            # for å holde kartet rent rundt "ekte" tog.
            if tags.get("train") != "yes" and any(
                tags.get(m) == "yes" for m in ("subway", "tram", "light_rail")
            ):
                continue
            slim = slim_properties(tags, STATION_TAGS)
            stations.append({
                "type": "Feature",
                "geometry": geom,
                "properties": slim,
            })
    return railways, stations


def normalize_operators(railways: list[dict]) -> int:
    """Slå sammen case- og whitespace-varianter av operator-tag in-place.

    OSM-data har f.eks. både «Bane NOR» og «Bane Nor» — som skaper duplikate
    checkboxes i UI. Vi velger som canonical-navn den varianten som har
    flest km, og oppdaterer alle features til å bruke den. Returnerer antall
    features som ble endret (for logging)."""
    raw: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for f in railways:
        op = (f["properties"].get("operator") or "").strip()
        if not op:
            continue
        raw[op.lower()][op] += f["properties"].get("length_km", 0)

    canonical_map: dict[str, str] = {}
    for variants in raw.values():
        if len(variants) <= 1:
            continue  # ingen kollapsing nødvendig
        canonical = max(variants.items(), key=lambda kv: kv[1])[0]
        for variant in variants:
            if variant != canonical:
                canonical_map[variant] = canonical

    if not canonical_map:
        return 0
    changed = 0
    for f in railways:
        op = (f["properties"].get("operator") or "").strip()
        if op in canonical_map:
            f["properties"]["operator"] = canonical_map[op]
            changed += 1
    return changed


def is_electrified(props: dict) -> bool:
    """OSM `electrified` kan være 'contact_line', 'rail', 'no', 'yes', osv.
    Alt utenom 'no' og tomt regnes som elektrifisert."""
    val = (props.get("electrified") or "").strip().lower()
    return bool(val) and val != "no"


def track_capacity_km(railways: list[dict]) -> dict[str, float]:
    """Aggregerer lengde per spor-kategori. Bøttelogikken er flyttet til
    `bucket_track()` (delt med public/helpers.js)."""
    buckets = {"Enkeltspor": 0.0, "Dobbeltspor": 0.0, "Multispor (3+)": 0.0, "Ikke tagget": 0.0}
    for f in railways:
        props = f["properties"]
        b = bucket_track(props.get("passenger_lines"), props.get("service"))
        if b is None:
            continue
        buckets[b] += props.get("length_km", 0)
    return {k: round(v, 1) for k, v in buckets.items()}


def parse_population(raw: Any) -> int:
    """OSM population-tag kan være '1110887', '1 110 887', '1,110,887'."""
    if not raw:
        return 0
    s = str(raw).replace(" ", "").replace(",", "").replace("\xa0", "")
    return int(s) if s.isdigit() else 0


def compute_population_coverage(stations: list[dict]) -> dict[str, Any] | None:
    """Andel av befolkningen som bor innen X km fra nærmeste togstasjon.

    Bruker `data/places.json` (OSM `place=*` med `population`-tag).
    Bare "ekte" togstasjoner (railway=station|halt) brukes — t-bane og
    trikk-stopp ekskluderes siden vi vurderer "togtilbud".
    """
    if not PLACES_FILE.exists():
        print(f"  (hopper over befolkningsdekning — {PLACES_FILE.name} mangler)")
        return None

    places = json.loads(PLACES_FILE.read_text(encoding="utf-8"))["elements"]

    rail_stations = [
        s for s in stations
        if s["properties"].get("railway") in {"station", "halt"}
    ]
    if not rail_stations:
        return None

    # Projiser stasjoner og steder til UTM33 (meter) for distanseberegning.
    station_coords = [
        TO_UTM33.transform(*s["geometry"]["coordinates"])
        for s in rail_stations
    ]
    place_data = []
    for p in places:
        pop = parse_population(p["tags"].get("population"))
        if pop <= 0 or "lon" not in p or "lat" not in p:
            continue
        x, y = TO_UTM33.transform(p["lon"], p["lat"])
        place_data.append((x, y, pop, p["tags"].get("name", "?"), p["tags"].get("place")))

    # STRtree indekserer stasjoner som punkter for rask nærmeste-naboslag.
    from shapely.geometry import Point
    from shapely.strtree import STRtree
    station_points = [Point(x, y) for x, y in station_coords]
    tree = STRtree(station_points)

    bands = {"≤2 km": 0, "2–5 km": 0, "5–10 km": 0, "10–25 km": 0, ">25 km": 0}
    total_pop = 0
    examples_unserved: list[tuple[str, int, float]] = []  # (name, pop, distance_km)

    for x, y, pop, name, _ptype in place_data:
        total_pop += pop
        nearest_idx = tree.nearest(Point(x, y))
        nearest = station_points[nearest_idx]
        d_km = ((x - nearest.x) ** 2 + (y - nearest.y) ** 2) ** 0.5 / 1000

        if d_km <= 2:
            bands["≤2 km"] += pop
        elif d_km <= 5:
            bands["2–5 km"] += pop
        elif d_km <= 10:
            bands["5–10 km"] += pop
        elif d_km <= 25:
            bands["10–25 km"] += pop
        else:
            bands[">25 km"] += pop
            if pop >= 5000:
                examples_unserved.append((name, pop, d_km))

    examples_unserved.sort(key=lambda x: -x[1])
    pct = {k: round(100 * v / total_pop, 1) if total_pop else 0 for k, v in bands.items()}
    return {
        "total_population": total_pop,
        "place_count": len(place_data),
        "rail_station_count": len(rail_stations),
        "bands_population": bands,
        "bands_pct": pct,
        "largest_unserved": [
            {"name": n, "population": p, "distance_km": round(d, 1)}
            for n, p, d in examples_unserved[:10]
        ],
        "note": "Basert på OSM place-noder med population-tag. Total ≈ Norges befolkning. "
                "Bare jernbanestasjoner og holdeplasser teller (t-bane/trikk ekskludert).",
    }


def estimate_diesel_co2_tonnes(non_electrified_km: float) -> dict[str, Any]:
    """Grovt CO₂-anslag. Selve tonn-tallet og forklaringsteksten er flyttet
    til delte konstanter (CO2_ASSUMPTIONS, CO2_ASSUMPTION_TEXT) speilet i
    public/helpers.js. Tallet er bevisst en størrelsesorden — Nordlandsbanen
    ligger høyere, sidebaner mye lavere."""
    return {
        "tonnes_per_year": co2_estimate_tonnes_per_year(non_electrified_km),
        "assumption_text": CO2_ASSUMPTION_TEXT,
    }


def compute_stats(railways: list[dict], stations: list[dict]) -> dict[str, Any]:
    total_km = sum(f["properties"].get("length_km", 0) for f in railways)
    elec_km = sum(
        f["properties"].get("length_km", 0)
        for f in railways
        if is_electrified(f["properties"])
    )

    # Lengde per spenningssystem (15 kV / 25 kV / DC osv.)
    voltage_km: dict[str, float] = defaultdict(float)
    for f in railways:
        props = f["properties"]
        if not is_electrified(props):
            continue
        voltage = props.get("voltage", "ukjent")
        freq = props.get("frequency")
        key = f"{voltage} V / {freq} Hz" if freq else f"{voltage} V"
        voltage_km[key] += props.get("length_km", 0)

    # Lengde per operatør. Operator-feltet er allerede normalisert via
    # normalize_operators() før kall til compute_stats.
    operator_km: dict[str, float] = defaultdict(float)
    for f in railways:
        op = f["properties"].get("operator", "ukjent")
        operator_km[op] += f["properties"].get("length_km", 0)

    # Lengde per railway-type (rail / tram / subway / …)
    type_km: dict[str, float] = defaultdict(float)
    for f in railways:
        rwy = f["properties"].get("railway", "ukjent")
        type_km[rwy] += f["properties"].get("length_km", 0)

    # Topp 20 raskeste spor (ranket på maxspeed)
    fastest = sorted(
        (f for f in railways if "maxspeed_kmh" in f["properties"]),
        key=lambda f: f["properties"]["maxspeed_kmh"],
        reverse=True,
    )[:20]
    fastest_summary = [
        {
            "name": f["properties"].get("name") or f["properties"].get("ref") or "(uten navn)",
            "maxspeed_kmh": f["properties"]["maxspeed_kmh"],
            "length_km": f["properties"].get("length_km", 0),
        }
        for f in fastest
    ]

    non_elec_km = total_km - elec_km
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total_km": round(total_km, 1),
        "electrified_km": round(elec_km, 1),
        "electrified_pct": round(100 * elec_km / total_km, 1) if total_km else 0,
        "non_electrified_km": round(non_elec_km, 1),
        "diesel_co2_estimate": estimate_diesel_co2_tonnes(non_elec_km),
        "voltage_breakdown_km": {k: round(v, 1) for k, v in
                                 sorted(voltage_km.items(), key=lambda kv: -kv[1])},
        "operator_breakdown_km": {k: round(v, 1) for k, v in
                                  sorted(operator_km.items(), key=lambda kv: -kv[1])[:15]},
        "type_breakdown_km": {k: round(v, 1) for k, v in
                              sorted(type_km.items(), key=lambda kv: -kv[1])},
        "fastest_sections": fastest_summary,
        "speed_distribution_km": compute_speed_distribution(railways),
        "track_capacity_km": track_capacity_km(railways),
        "routes": compute_routes(railways),
        "station_count": len(stations),
        "railway_segment_count": len(railways),
        "population_coverage": compute_population_coverage(stations),
    }


def compute_routes(railways: list[dict]) -> list[dict]:
    """Grupper sporsegmenter på `name` (eller `ref` der navn mangler).

    En "rute" er logisk én jernbanelinje (Bergensbanen, Gardermobanen, osv.)
    som i OSM kan ligge som mange små segmenter. Vi samler dem her for
    bedre statistikk og søk.
    """
    groups: dict[str, list[dict]] = defaultdict(list)
    for f in railways:
        props = f["properties"]
        name = props.get("name") or props.get("ref")
        if not name:
            continue
        groups[name].append(props)

    excluded_service = {"siding", "yard", "spur", "crossover"}
    routes = []
    for name, members in groups.items():
        total_km = sum(m.get("length_km", 0) for m in members)
        elec_km = sum(m.get("length_km", 0) for m in members if is_electrified(m))
        speeds = [m["maxspeed_kmh"] for m in members if "maxspeed_kmh" in m]
        operators = sorted({m.get("operator") for m in members if m.get("operator")})
        railway_types = sorted({m.get("railway") for m in members if m.get("railway")})

        # Spor-kapasitet (kun hovedspor — siding/yard/spur teller ikke).
        main_km = sum(m.get("length_km", 0) for m in members
                      if m.get("service") not in excluded_service)
        double_km = sum(
            m.get("length_km", 0) for m in members
            if m.get("service") not in excluded_service
            and (parse_passenger_lines(m.get("passenger_lines")) or 0) >= 2
        )
        tagged_km = sum(
            m.get("length_km", 0) for m in members
            if m.get("service") not in excluded_service
            and parse_passenger_lines(m.get("passenger_lines")) is not None
        )

        # Hastighetsfordeling per rute — brukes til mini-profil i UI.
        route_speed_dist = compute_speed_distribution(
            [{"properties": m} for m in members]
        )

        routes.append({
            "name": name,
            "slug": slugify(name),
            "total_km": round(total_km, 2),
            "segments": len(members),
            "electrified_km": round(elec_km, 2),
            "electrified_pct": round(100 * elec_km / total_km, 1) if total_km else 0,
            "max_speed_kmh": max(speeds) if speeds else None,
            "mean_speed_kmh": round(sum(speeds) / len(speeds), 1) if speeds else None,
            "double_track_km": round(double_km, 2),
            "double_track_pct": round(100 * double_km / tagged_km, 1) if tagged_km else None,
            "track_tag_coverage_pct": round(100 * tagged_km / main_km, 1) if main_km else 0,
            "speed_distribution_km": route_speed_dist,
            "operators": operators,
            "types": railway_types,
        })

    routes.sort(key=lambda r: r["total_km"], reverse=True)

    # Disambiguer eventuelle slug-kollisjoner (f.eks. to ruter som normaliserer
    # til samme slug). Veldig sjeldent, men tryggere å håndtere enn å la dem
    # overskrive hverandre.
    seen: dict[str, int] = {}
    for r in routes:
        base = r["slug"]
        n = seen.get(base, 0)
        if n > 0:
            r["slug"] = f"{base}-{n + 1}"
            print(f"  ! slug-kollisjon: «{r['name']}» → {r['slug']}")
        seen[base] = n + 1

    return routes


def write_route_files(railways: list[dict], routes: list[dict],
                      output_dir: Path) -> None:
    """Skriv én geojson-fil per rute. Lar bane.html laste ~100 KB i stedet
    for hele 8 MB railways.geojson."""
    by_name: dict[str, list[dict]] = defaultdict(list)
    for f in railways:
        n = f["properties"].get("name") or f["properties"].get("ref")
        if n:
            by_name[n].append(f)

    # Rens gamle filer i tilfelle ruter har blitt fjernet/omdøpt mellom kjøringer.
    for old in output_dir.glob("*.geojson"):
        old.unlink()

    for route in routes:
        segments = by_name.get(route["name"], [])
        (output_dir / f"{route['slug']}.geojson").write_text(
            json.dumps({"type": "FeatureCollection", "features": segments}),
            encoding="utf-8",
        )


def compute_speed_distribution(railways: list[dict]) -> dict[str, float]:
    """Lengde gruppert i hastighetsbøtter.

    Bøttene følger norske milepæler:
      <80 (lokal), 80–130 (konvensjonell), 130–160, 160–200,
      200+ (høyhastighet), Ukjent.

    Stasjons- og sidespor (`service=siding|yard|spur|crossover`) ekskluderes
    siden de har lave hastigheter som skjevvrir fordelingen.
    """
    buckets = {
        "<80": 0.0,
        "80–130": 0.0,
        "130–160": 0.0,
        "160–200": 0.0,
        "200+": 0.0,
        "Ukjent": 0.0,
    }
    for f in railways:
        props = f["properties"]
        b = bucket_speed(props.get("maxspeed_kmh"), props.get("service"))
        if b is None:
            continue
        buckets[b] += props.get("length_km", 0)
    return {k: round(v, 1) for k, v in buckets.items()}


def main() -> int:
    if not RAW_FILE.exists():
        print(f"Fant ikke {RAW_FILE}. Kjør fetch.py først.", file=sys.stderr)
        return 1

    print(f"Leser {RAW_FILE.name}…")
    raw = json.loads(RAW_FILE.read_text(encoding="utf-8"))

    print("Konverterer til GeoJSON…")
    geojson = osm2geojson.json2geojson(raw)
    features = geojson["features"]
    print(f"  {len(features)} features fra Overpass")

    print("Splitter spor og stasjoner, beregner lengder…")
    railways, stations = split_features(features)
    print(f"  {len(railways)} sporsegmenter, {len(stations)} stasjoner")

    changed = normalize_operators(railways)
    if changed:
        print(f"  normaliserte {changed} operator-tags (case-varianter slått sammen)")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    (OUTPUT_DIR / "railways.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": railways}),
        encoding="utf-8",
    )
    (OUTPUT_DIR / "stations.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": stations}),
        encoding="utf-8",
    )

    print("Beregner statistikk…")
    stats = compute_stats(railways, stations)
    (OUTPUT_DIR / "stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("Skriver per-rute geojson-filer…")
    routes_dir = OUTPUT_DIR / "routes"
    routes_dir.mkdir(parents=True, exist_ok=True)
    write_route_files(railways, stats["routes"], routes_dir)
    print(f"  {len(stats['routes'])} ruter skrevet til {routes_dir.name}/")

    print(f"\nFerdig. Total banelengde: {stats['total_km']} km, "
          f"hvorav {stats['electrified_pct']}% elektrifisert.")
    print(f"Output skrevet til {OUTPUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
