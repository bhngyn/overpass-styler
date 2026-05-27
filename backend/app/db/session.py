"""SQLite session/engine setup."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from .models import Base


def _db_url() -> str:
    # Allow tests/dev to override; default for production is the mounted volume.
    if url := os.environ.get("OVERPASS_STYLER_DB_URL"):
        return url
    data_dir = Path(os.environ.get("OVERPASS_STYLER_DATA_DIR", "/data"))
    if not data_dir.exists():
        # Fall back to repo-local for local non-docker runs.
        data_dir = Path(__file__).resolve().parents[3] / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{data_dir / 'overpass-styler.sqlite'}"


_engine = create_engine(_db_url(), echo=False, future=True)
SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False, class_=Session)


def init_db() -> None:
    Base.metadata.create_all(_engine)
    _apply_lightweight_migrations()


def _apply_lightweight_migrations() -> None:
    """SQLite-only additive migrations for columns introduced after first release.

    ``create_all`` won't ALTER existing tables, so when we add a new nullable
    column to a model we add it here too. Investigators carrying a pre-existing
    DB volume keep their data; fresh DBs get the column from the model itself.
    """
    inspector = inspect(_engine)
    if "source_files" in inspector.get_table_names():
        existing_cols = {c["name"] for c in inspector.get_columns("source_files")}
        additions = [
            ("category_key", "ALTER TABLE source_files ADD COLUMN category_key VARCHAR"),
            ("overpass_query", "ALTER TABLE source_files ADD COLUMN overpass_query TEXT"),
            ("bbox_json", "ALTER TABLE source_files ADD COLUMN bbox_json TEXT"),
        ]
        for col, ddl in additions:
            if col in existing_cols:
                continue
            try:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
            except Exception:
                # A racing process may have added the column already, or a
                # fresh DB created the column via create_all between the
                # inspect() call and the ALTER. Either way, the column now
                # exists — that's the only state we cared about.
                pass


def get_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
