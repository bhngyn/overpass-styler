"""FastAPI entrypoint. Serves the JSON API under /api and the built frontend at /."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import annotations, enrich, icons, presets, projects
from app.db.session import init_db


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="Overpass Styler",
        version="0.1.0",
        description="Style Overpass Turbo KML exports before importing into Google Earth Pro.",
        lifespan=_lifespan,
    )

    # Dev: allow Vite dev server.
    if os.environ.get("OVERPASS_STYLER_DEV") == "1":
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["http://localhost:5173"],
            allow_methods=["*"],
            allow_headers=["*"],
        )

    api_routers = [
        projects.router,
        annotations.router,
        enrich.router,
        presets.router,
        icons.router,
    ]
    for r in api_routers:
        app.include_router(r, prefix="/api")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    # Mount the built frontend if present (production / docker).
    static_dir = Path(__file__).resolve().parents[1] / "static"
    if static_dir.exists():
        app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")

        @app.get("/{full_path:path}")
        def spa(full_path: str):  # noqa: ARG001 - catch-all for SPA routing
            return FileResponse(static_dir / "index.html")

    return app


app = create_app()
