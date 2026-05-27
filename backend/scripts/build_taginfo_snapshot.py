"""Build a static Taginfo snapshot for the frontend.

Iterates every curated glossary entry in
``app.kml.tag_glossary`` and fetches its Taginfo ``/tag/wiki_pages``
payload (via the existing ``app.enrichment.taginfo`` client, which caches
on disk for 7 days). The result is written as a TypeScript module that
ships with the frontend — so the SubjectChip in the Query Builder can
render OSM-wiki context **without any network call at runtime**.

Output: ``frontend/src/lib/taginfoSnapshot.ts``

Usage::

    cd backend
    .venv/bin/python scripts/build_taginfo_snapshot.py

The first run takes ~one minute (the rate-limited client sleeps 1s per
new request). Cache-warm reruns finish in under a second. Re-run any
time the curated glossary changes; commit the regenerated TS file.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

# Make the script importable from the repo root without manual PYTHONPATH.
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.enrichment.taginfo import TaginfoError, get_tag  # noqa: E402
from app.kml.tag_glossary import all_entries  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_PATH = REPO_ROOT / "frontend" / "src" / "lib" / "taginfoSnapshot.ts"


def _best_wiki_page(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Pick the English wiki page from Taginfo's ``data`` array.

    Taginfo returns one entry per language. We prefer English by ``lang``,
    ``language``, or ``language_en``; fall back to the first row.
    """
    pages = payload.get("data")
    if not isinstance(pages, list) or not pages:
        return None
    for p in pages:
        if not isinstance(p, dict):
            continue
        lang = (p.get("lang") or "").lower()
        language = (p.get("language") or "").lower()
        language_en = (p.get("language_en") or "").lower()
        if lang == "en" or language == "en" or language_en == "english":
            return p
    first = pages[0]
    return first if isinstance(first, dict) else None


def _related_tags(page: dict[str, Any] | None) -> list[str]:
    """Flatten the wiki page's combination / implied / linked tag lists.

    Each entry is a ``key=value`` string (or ``key=*`` for wildcards).
    De-duplicated; ordering favours the strongest signal first
    (combination → implied → linked).
    """
    if not page:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for field in ("tags_combination", "tags_implies", "tags_linked"):
        raw = page.get(field)
        if not isinstance(raw, list):
            continue
        for item in raw:
            if not isinstance(item, str):
                continue
            normalised = item.strip()
            if not normalised or normalised in seen:
                continue
            seen.add(normalised)
            out.append(normalised)
    return out


def _image(page: dict[str, Any] | None) -> dict[str, str | None] | None:
    if not page:
        return None
    img = page.get("image")
    if not isinstance(img, dict):
        return None
    thumb = img.get("thumb_url") if isinstance(img.get("thumb_url"), str) else None
    full = img.get("image_url") if isinstance(img.get("image_url"), str) else None
    title = img.get("title") if isinstance(img.get("title"), str) else None
    if not (thumb or full):
        return None
    return {"thumb_url": thumb, "image_url": full, "title": title}


def _description(payload: dict[str, Any], page: dict[str, Any] | None) -> str | None:
    """Wiki description text — prefer page-level, fall back to envelope."""
    if page:
        desc = page.get("description")
        if isinstance(desc, str) and desc.strip():
            return desc.strip()
    desc = payload.get("description")
    if isinstance(desc, str) and desc.strip():
        return desc.strip()
    return None


def _wiki_url(key: str, value: str) -> str:
    # Match the URL shape ``backend/app/api/tag_library.py:_wiki_url`` returns
    # so the snapshot URL is identical to what the live drawer would use.
    import urllib.parse as up

    return (
        "https://wiki.openstreetmap.org/wiki/Tag:"
        f"{up.quote(key, safe='')}%3D{up.quote(value, safe='')}"
    )


async def _build_one(key: str, value: str) -> dict[str, Any]:
    payload = await get_tag(key, value)
    page = _best_wiki_page(payload)
    return {
        "key": key,
        "value": value,
        "description": _description(payload, page),
        "relatedTags": _related_tags(page),
        "image": _image(page),
        "wikiUrl": _wiki_url(key, value),
    }


async def build_snapshot() -> dict[str, dict[str, Any]]:
    snapshot: dict[str, dict[str, Any]] = {}
    entries = [e for e in all_entries() if e.value is not None]
    total = len(entries)
    for i, entry in enumerate(entries, start=1):
        tag_key = f"{entry.key}={entry.value}"
        print(f"[{i:>2}/{total}] {tag_key}", flush=True)
        try:
            snapshot[tag_key] = await _build_one(entry.key, entry.value)
        except TaginfoError as e:
            print(f"  ! Taginfo error: {e} — skipping", flush=True)
            continue
    return snapshot


def _emit_ts(snapshot: dict[str, dict[str, Any]]) -> str:
    """Serialise to a TypeScript module.

    JSON.stringify-compatible output keeps the diff predictable: stable
    key ordering, two-space indent, trailing newline. Importers get a
    ``Record<string, TaginfoSnapshotEntry>`` typed by the inline
    interface above the data literal.
    """
    body = json.dumps(snapshot, indent=2, ensure_ascii=False, sort_keys=True)
    return (
        "/**\n"
        " * Static Taginfo snapshot.\n"
        " *\n"
        " * Generated by ``backend/scripts/build_taginfo_snapshot.py`` from the\n"
        " * curated glossary in ``backend/app/kml/tag_glossary.py``. **Do not\n"
        " * edit by hand** — re-run the script after changing the glossary.\n"
        " *\n"
        " * Every entry here was queried from taginfo.openstreetmap.org at build\n"
        " * time, so the SubjectChip provenance reveal can render OSM-wiki\n"
        " * descriptions and related-tag chips without any runtime network call.\n"
        " * The investigator never sees a consent prompt for this data; it ships\n"
        " * with the app.\n"
        " */\n"
        "\n"
        "export interface TaginfoSnapshotEntry {\n"
        "  key: string;\n"
        "  value: string;\n"
        "  description: string | null;\n"
        "  relatedTags: string[];\n"
        "  image: { thumb_url: string | null; image_url: string | null; title: string | null } | null;\n"
        "  wikiUrl: string;\n"
        "}\n"
        "\n"
        "export const TAGINFO_SNAPSHOT: Record<string, TaginfoSnapshotEntry> =\n"
        f"  {body};\n"
    )


def main() -> None:
    print(f"Building Taginfo snapshot → {OUTPUT_PATH}")
    snapshot = asyncio.run(build_snapshot())
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(_emit_ts(snapshot), encoding="utf-8")
    print(f"Wrote {len(snapshot)} entries → {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
