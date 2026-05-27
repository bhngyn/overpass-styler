"""Tag Library router.

Surfaces three content layers to the frontend Tag Library drawer:

1. ``GET /api/tag-library/curated`` — the hand-written atrocity-investigation
   glossary (no network).
2. ``GET /api/tag-library/keys``, ``/values``, ``/tag``, ``/search`` — thin,
   cached pass-throughs to the public Taginfo API.
3. ``/tag`` additionally merges the matching glossary entry (if any) and the
   canonical wiki URL into a single response — the drawer renders all three
   side-by-side.

Network calls are opt-in (the investigator clicks "Look up on Taginfo"),
rate-limited at 1 req/s in :mod:`app.enrichment.taginfo`, and cached on disk
for 7 days. The :mod:`app.kml.tag_glossary` endpoint never touches the
network.

Per the integration plan, **this router is not registered in ``main.py``** —
the integrator wires it in once all parallel A-phase agents have landed.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.enrichment.taginfo import TaginfoError, get_keys, get_tag, get_values, search_by_keyword
from app.kml.tag_glossary import GlossaryEntry, all_entries, find

router = APIRouter(prefix="/tag-library", tags=["tag-library"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class GlossaryEntrySchema(BaseModel):
    """Public shape of a curated glossary entry."""

    id: str
    key: str
    value: str | None
    domain: str
    label: str
    field_note: str
    related_tags: list[str] = Field(default_factory=list)
    default_overpass_clause: str | None = None
    default_icon_id: str | None = None

    @classmethod
    def from_entry(cls, entry: GlossaryEntry) -> GlossaryEntrySchema:
        return cls(
            id=entry.id,
            key=entry.key,
            value=entry.value,
            domain=entry.domain,
            label=entry.label,
            field_note=entry.field_note,
            related_tags=list(entry.related_tags),
            default_overpass_clause=entry.default_overpass_clause,
            default_icon_id=entry.default_icon_id,
        )


class CuratedResponse(BaseModel):
    entries: list[GlossaryEntrySchema]


class TaginfoKey(BaseModel):
    key: str
    count_all: int = 0
    count_all_fraction: float | None = None
    in_wiki: bool | None = None


class TaginfoKeysResponse(BaseModel):
    data: list[TaginfoKey]


class TaginfoValue(BaseModel):
    value: str
    count: int = 0
    fraction: float | None = None
    description: str | None = None


class TaginfoValuesResponse(BaseModel):
    key: str
    data: list[TaginfoValue]


class MergedTagResponse(BaseModel):
    """``/tag``: Taginfo payload + curated entry + canonical wiki URL."""

    key: str
    value: str
    taginfo: dict[str, Any]
    curated: GlossaryEntrySchema | None
    wiki_url: str


class SearchHit(BaseModel):
    """A single search result row.

    ``source`` is one of ``"curated"`` or ``"taginfo"`` so the frontend can
    style and rank them differently. Curated hits surface first.
    """

    source: str
    key: str
    value: str | None
    label: str | None = None
    score: float = 0.0
    curated: GlossaryEntrySchema | None = None
    taginfo: dict[str, Any] | None = None


class SearchResponse(BaseModel):
    q: str
    hits: list[SearchHit]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _wiki_url(key: str, value: str | None) -> str:
    """Build the canonical wiki.openstreetmap.org URL for a key or key=value."""
    if value:
        return f"https://wiki.openstreetmap.org/wiki/Tag:{quote(key, safe='')}%3D{quote(value, safe='')}"
    return f"https://wiki.openstreetmap.org/wiki/Key:{quote(key, safe='')}"


def _coerce_keys(rows: list[dict[str, Any]]) -> list[TaginfoKey]:
    out: list[TaginfoKey] = []
    for r in rows:
        key = r.get("key")
        if not isinstance(key, str):
            continue
        out.append(
            TaginfoKey(
                key=key,
                count_all=int(r.get("count_all", 0) or 0),
                count_all_fraction=_maybe_float(r.get("count_all_fraction")),
                in_wiki=_maybe_bool(r.get("in_wiki")),
            )
        )
    return out


def _coerce_values(rows: list[dict[str, Any]]) -> list[TaginfoValue]:
    out: list[TaginfoValue] = []
    for r in rows:
        value = r.get("value")
        if not isinstance(value, str):
            continue
        out.append(
            TaginfoValue(
                value=value,
                count=int(r.get("count", 0) or 0),
                fraction=_maybe_float(r.get("fraction")),
                description=_maybe_str(r.get("description")),
            )
        )
    return out


def _maybe_float(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _maybe_bool(v: Any) -> bool | None:
    if isinstance(v, bool):
        return v
    return None


def _maybe_str(v: Any) -> str | None:
    if isinstance(v, str) and v:
        return v
    return None


def _score_curated(entry: GlossaryEntry, q: str) -> float:
    """Rank curated entries by how directly they match ``q``.

    Scoring is intentionally simple — the frontend handles tie-breaking and
    visual grouping. Curated hits are pre-boosted by the caller so even the
    lowest-scoring curated match ranks above any Taginfo result.
    """
    ql = q.lower().strip()
    if not ql:
        return 0.0
    score = 0.0
    if ql == entry.key or ql == (entry.value or ""):
        score += 5.0
    if ql in entry.label.lower():
        score += 3.0
    if ql in entry.key.lower():
        score += 2.0
    if entry.value and ql in entry.value.lower():
        score += 2.0
    if ql in entry.field_note.lower():
        score += 1.0
    if ql in entry.domain.lower():
        score += 1.0
    for related in entry.related_tags:
        if ql in related.lower():
            score += 0.5
    return score


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/curated", response_model=CuratedResponse)
def curated() -> CuratedResponse:
    """Return the full curated glossary. Never touches the network."""
    return CuratedResponse(
        entries=[GlossaryEntrySchema.from_entry(e) for e in all_entries()],
    )


@router.get("/keys", response_model=TaginfoKeysResponse)
async def keys(
    min_count: int = Query(1000, ge=0, description="Filter out keys below this usage threshold."),
) -> TaginfoKeysResponse:
    """Taginfo passthrough — popular OSM keys, sorted by usage count desc."""
    try:
        rows = await get_keys(min_count=min_count)
    except TaginfoError as exc:
        raise HTTPException(status_code=502, detail=f"Taginfo call failed: {exc}") from exc
    return TaginfoKeysResponse(data=_coerce_keys(rows))


@router.get("/values", response_model=TaginfoValuesResponse)
async def values(
    key: str = Query(..., min_length=1),
    limit: int = Query(100, ge=1, le=500),
) -> TaginfoValuesResponse:
    """Taginfo passthrough — top values for the given key."""
    try:
        rows = await get_values(key, limit=limit)
    except TaginfoError as exc:
        raise HTTPException(status_code=502, detail=f"Taginfo call failed: {exc}") from exc
    return TaginfoValuesResponse(key=key, data=_coerce_values(rows))


@router.get("/tag", response_model=MergedTagResponse)
async def tag(
    key: str = Query(..., min_length=1),
    value: str = Query(..., min_length=1),
) -> MergedTagResponse:
    """Merged ``key=value`` view: Taginfo wiki payload + curated + wiki URL.

    The frontend uses the curated entry (if any) as the editorial header and
    falls back to the Taginfo wiki summary for the OSM-side description.
    """
    try:
        payload = await get_tag(key, value)
    except TaginfoError as exc:
        raise HTTPException(status_code=502, detail=f"Taginfo call failed: {exc}") from exc

    matches = find(key, value)
    curated_entry = (
        GlossaryEntrySchema.from_entry(matches[0]) if matches else None
    )
    return MergedTagResponse(
        key=key,
        value=value,
        taginfo=payload,
        curated=curated_entry,
        wiki_url=_wiki_url(key, value),
    )


@router.get("/search", response_model=SearchResponse)
async def search(
    q: str = Query(..., min_length=1, max_length=100),
) -> SearchResponse:
    """Free-text search across curated entries and Taginfo's by-keyword index.

    Curated matches are pre-boosted so even the weakest editorial hit ranks
    above any raw OSM-key match; investigators searching "detention" should
    see the hand-written entries first, then Taginfo's noise.
    """
    hits: list[SearchHit] = []

    # Curated layer (no network).
    curated_boost = 100.0
    for entry in all_entries():
        s = _score_curated(entry, q)
        if s > 0:
            hits.append(
                SearchHit(
                    source="curated",
                    key=entry.key,
                    value=entry.value,
                    label=entry.label,
                    score=s + curated_boost,
                    curated=GlossaryEntrySchema.from_entry(entry),
                )
            )

    # Taginfo layer. If the network call fails, we still return curated hits
    # rather than blowing up the whole request — degraded mode is the right
    # behaviour for an opt-in enrichment.
    try:
        rows = await search_by_keyword(q)
    except TaginfoError:
        rows = []

    for r in rows:
        key = r.get("key")
        if not isinstance(key, str):
            continue
        value = r.get("value") if isinstance(r.get("value"), str) else None
        # Taginfo's by_keyword returns a `count_all` we can use as a soft tiebreak.
        count = float(r.get("count_all", 0) or 0)
        hits.append(
            SearchHit(
                source="taginfo",
                key=key,
                value=value,
                label=f"{key}={value}" if value else key,
                score=count / 1_000_000.0,  # normalise into roughly 0..few-units
                taginfo=r,
            )
        )

    hits.sort(key=lambda h: h.score, reverse=True)
    return SearchResponse(q=q, hits=hits)
