"""Hent norsk jernbanedata fra Overpass API.

Kjører Overpass-spørringen i `overpass_query.txt` og lagrer rå JSON-respons
til `data/raw.json`. Hopper over hvis filen allerede finnes (slett den for
å hente på nytt).
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import requests

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

USER_AGENT = "norsk-jernbane-kart/0.1 (hobbyprosjekt; janarne84@gmail.com)"

ROOT = Path(__file__).resolve().parent
QUERY_FILE = ROOT / "overpass_query.txt"
OUTPUT_FILE = ROOT / "raw.json"


def fetch(query: str) -> bytes:
    """Prøv hver Overpass-instans i tur og orden til en svarer."""
    last_error: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        print(f"  → prøver {endpoint}", file=sys.stderr)
        try:
            response = requests.post(
                endpoint,
                data={"data": query},
                headers={"User-Agent": USER_AGENT},
                timeout=360,
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
        size_mb = OUTPUT_FILE.stat().st_size / 1024 / 1024
        print(f"{OUTPUT_FILE.name} finnes allerede ({size_mb:.1f} MB). "
              f"Slett den for å hente på nytt.")
        return 0

    query = QUERY_FILE.read_text(encoding="utf-8")
    print(f"Sender Overpass-spørring ({len(query)} tegn)…")
    start = time.monotonic()
    payload = fetch(query)
    elapsed = time.monotonic() - start

    OUTPUT_FILE.write_bytes(payload)
    size_mb = len(payload) / 1024 / 1024
    print(f"Skrev {OUTPUT_FILE.name}: {size_mb:.1f} MB på {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
