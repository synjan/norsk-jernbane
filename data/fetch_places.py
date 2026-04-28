"""Hent norske befolkede steder (city/town/village/...) med population-tag.

Skriver til `data/places.json`. Brukes av `process.py` for å beregne
befolkningsdekning (hvor stor andel av befolkningen som bor innen X km
fra nærmeste togstasjon).
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import requests

from fetch import OVERPASS_ENDPOINTS, USER_AGENT  # gjenbruker endpoint-listen

ROOT = Path(__file__).resolve().parent
QUERY_FILE = ROOT / "places_query.txt"
OUTPUT_FILE = ROOT / "places.json"


def fetch(query: str) -> bytes:
    last_error: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        print(f"  → prøver {endpoint}", file=sys.stderr)
        try:
            response = requests.post(
                endpoint,
                data={"data": query},
                headers={"User-Agent": USER_AGENT},
                timeout=180,
            )
            response.raise_for_status()
            return response.content
        except requests.RequestException as exc:
            last_error = exc
            print(f"    feil: {exc}", file=sys.stderr)
            time.sleep(2)
    raise RuntimeError(f"Alle Overpass-instanser feilet. Siste feil: {last_error}")


def main() -> int:
    if OUTPUT_FILE.exists():
        size_kb = OUTPUT_FILE.stat().st_size / 1024
        print(f"{OUTPUT_FILE.name} finnes allerede ({size_kb:.1f} KB). "
              f"Slett den for å hente på nytt.")
        return 0

    query = QUERY_FILE.read_text(encoding="utf-8")
    print(f"Sender Overpass-spørring for steder ({len(query)} tegn)…")
    start = time.monotonic()
    payload = fetch(query)
    elapsed = time.monotonic() - start

    OUTPUT_FILE.write_bytes(payload)
    size_kb = len(payload) / 1024
    print(f"Skrev {OUTPUT_FILE.name}: {size_kb:.1f} KB på {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
