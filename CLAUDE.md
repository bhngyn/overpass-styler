# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dockerized browser tool that sits **between an Overpass Turbo KML export and a Google Earth Pro import**. Human rights investigators drop one or more KMLs into a project, group features by their OSM tags (`amenity`, `landuse`, …), assign per-category styling (fill colour + opacity, outline, icon, label) plus per-placemark annotations (note, source URL, date, confidence), and export a styled KML that opens cleanly in Google Earth Pro.

Scoping decisions (locked):
- **Deployment**: local `docker compose up` per investigator. No auth.
- **State**: persisted projects + reusable style presets in SQLite (volume-mounted).
- **Privacy**: online basemaps allowed; all other outbound traffic (Overpass re-fetch, Nominatim reverse-geocode) is opt-in per investigator action, with a confirmation prompt the first time per session.
- **Out of scope v1**: drawing custom placemarks, photo attachments, multi-user/auth.

The original requirements/scoping plan is at `/Users/brian/.claude/plans/walk-me-through-what-streamed-bunny.md`.

## How to run

### Production / investigator UX
```sh
docker compose up --build
# → http://localhost:8000
```
Data persists in `./data/` (gitignored, SQLite + uploaded KMLs).

### Local dev (two terminals, hot-reload)
```sh
# terminal 1 — backend
cd backend
.venv/bin/uvicorn app.main:app --reload --port 8000
# (one-time setup: uv venv --python 3.12 .venv && uv pip install -e ".[dev]")

# terminal 2 — frontend
cd frontend
npm run dev     # → http://localhost:5173, proxies /api to :8000
```

### Dockerized dev (single command, hot-reload via `docker compose watch`)
```sh
docker compose -f docker-compose.dev.yml up --watch --build
# → http://localhost:5173 (Vite dev server, proxies /api → backend:8000)
```
Two services: `backend` (uvicorn --reload) and `frontend` (vite dev). The
`develop.watch` blocks sync source files into each container on save —
backend reloads in ~1s, Vite HMR updates the browser without a full reload.
Dependency changes (`pyproject.toml`, `package.json`) trigger an image
rebuild automatically. The frontend container reads `VITE_API_TARGET` so its
proxy points at the backend service over the compose network.

## Tests

```sh
# Backend (pytest, 47 tests covering color parity, parse losslessness, full-stack API smoke)
cd backend && .venv/bin/pytest

# Frontend (vitest, color-helper parity with backend test vectors)
cd frontend && npx vitest run

# Frontend type-check
cd frontend && npx tsc -b
```

Color helpers exist in both Python (`backend/app/kml/color.py`) and TypeScript (`frontend/src/lib/kmlColor.ts`) because the live preview restyles in the browser but the export is built server-side. The two test files share the same vectors — **if you change one, change both**.

## End-to-end smoke recipe

The recipe the investigator can actually do, also runnable manually for verification:

1. `docker compose up --build` → http://localhost:8000
2. Create project "Chad — Detention sites".
3. **Import KML…** → `chad_prisons.kml`. Tree fills with `amenity=prison` (6 features).
4. Click the category. In the style editor: fill = red, opacity ≈ 50%, outline = solid 2px. Pick a red paddle icon. Map updates live.
5. Click any placemark. Add a `source_url` and `note`. Save.
6. Import `chad_cemeteries.kml`. Click `landuse=cemetery`. Style it differently (e.g. grey 30%).
7. **Export styled KML** → opens in Google Earth Pro. Pass criteria: each source file is its own Folder; polygons render with chosen colour/opacity; prison points use the chosen icon; clicking a placemark shows both OSM tags and the `hr:*` annotations.

Backend-only smoke (no browser, useful when iterating on the API):

```sh
cd backend
OVERPASS_STYLER_DATA_DIR=/tmp/smoke .venv/bin/uvicorn app.main:app --port 8765 &
PID=$(curl -sX POST localhost:8765/api/projects -H 'Content-Type: application/json' \
  -d '{"name":"smoke"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sX POST "localhost:8765/api/projects/$PID/source-files" \
  -F "file=@tests/fixtures/chad_prisons.kml" > /dev/null
curl -s "localhost:8765/api/projects/$PID/export" -o /tmp/styled.kml
python3 -c "from lxml import etree; print(etree.parse('/tmp/styled.kml').getroot()[0][0].tag)"
```

## Architecture

```
backend/                      Python 3.12, FastAPI, lxml, SQLAlchemy 2, SQLite
├── app/
│   ├── main.py               FastAPI entrypoint; serves /api/* and static frontend at /
│   ├── kml/                  The correctness-critical core
│   │   ├── parse.py          lxml-based, lossless ExtendedData
│   │   ├── serialize.py      injects <Style> blocks + <styleUrl>; re-parses output as self-check
│   │   ├── color.py          AABBGGRR helpers (mirrored in frontend)
│   │   ├── icons.py          Earth Pro built-in icon palette catalogue
│   │   ├── category.py       primary-tag detection (skips meta keys, prefers amenity/landuse/etc.)
│   │   └── style.py          PolygonStyle / IconStyle / LabelStyle / FeatureStyle dataclasses
│   ├── api/                  FastAPI routers + Pydantic schemas + converters
│   ├── enrichment/           Backend-proxied Overpass + Nominatim clients (rate-limited)
│   └── db/                   SQLAlchemy models + session
└── tests/
    └── fixtures/             symlinks to ../../chad_prisons.kml, chad_cemeteries.kml

frontend/                     React 19, Vite 8, TypeScript, Tailwind 4, MapLibre GL, Zustand
└── src/
    ├── App.tsx               picker ↔ workspace switcher
    ├── components/
    │   ├── ProjectPicker.tsx          landing — create / open
    │   ├── ProjectWorkspace.tsx       title bar + three-pane layout
    │   ├── ProjectTree.tsx            left pane: source files → categories → placemarks
    │   ├── MapPreview.tsx             centre pane: MapLibre with live category styling
    │   ├── ContextPanel.tsx           right pane: switches on selection kind
    │   ├── CategoryStyleEditor.tsx    polygon / icon / label editors + presets
    │   ├── PlacemarkInspector.tsx     OSM tags + annotations + enrichment buttons
    │   ├── ColorOpacityPicker.tsx     color picker with opacity slider and AABBGGRR readout
    │   ├── IconPicker.tsx             Earth Pro palette thumbnail grid
    │   └── ui/                        Button, Field, Toggle primitives
    ├── lib/
    │   ├── api.ts            typed client over /api
    │   ├── kmlColor.ts       AABBGGRR mirror of backend
    │   ├── geojson.ts        adapt PlacemarkPreview → GeoJSON for MapLibre
    │   ├── defaults.ts       starter palette + default FeatureStyle
    │   └── types.ts          mirrors backend Pydantic schemas
    └── stores/project.ts     Zustand store — single source of truth for the workspace

Dockerfile                    multi-stage: node build → python runtime, single port 8000
docker-compose.yml            mounts ./data:/data
```

### Style flow

1. Frontend edits a `FeatureStyle` (dataclass mirrored as TS interface) and PUTs it under `/api/projects/{id}/styles/{category_value}`.
2. Backend stores the style JSON on the `category_styles` table.
3. On export, the backend walks every placemark, picks the category style matching its category value (or a per-placemark override if set), emits a `<Style id="cat-{value}">` block in `<Document>`, and emits `<styleUrl>#cat-{value}</styleUrl>` inside each placemark. Annotations come along as `<Data name="hr:{field}">` inside ExtendedData. The serializer re-parses its own output before returning bytes — broken XML fails loudly.

### Data preservation contract

- **Never lose ExtendedData.** The parser preserves field order; the serializer emits in the same order. Tests in `tests/test_serialize_roundtrip.py` enforce byte-equality of coordinates and ExtendedData across a parse → serialize → parse cycle.
- **Don't reformat geometry coordinates.** Pass through the original `lon,lat` precision Overpass emits.
- **User annotations live under the `hr:` namespace** on Data names, so they round-trip cleanly into Earth Pro popups but never get confused with OSM tags.

## Conventions

- Both fixtures (`chad_prisons.kml`, `chad_cemeteries.kml`) are canonical test data — every parse/serialize change must run them in CI.
- KML color is `AABBGGRR`. Opacity is the *high* byte. Tests assert this in both languages.
- Enrichment endpoints are explicit, on-demand, user-confirmed actions. Never call OSM/Nominatim ambiently or as a side-effect of import.
