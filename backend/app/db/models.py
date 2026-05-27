r"""SQLAlchemy models.

Schema overview:

- ``Project``: the unit of investigator work. Has a name, a denormalised
  ``category_key`` (the most-populous primary tag across the project, kept for the
  project picker summary), one-to-many ``SourceFile``\s, and one-to-many
  ``CategoryStyle``s (one per distinct value of the category key).
- ``SourceFile``: an imported KML. Stores the raw bytes so we can re-export later
  without losing anything, plus the parsed Placemarks as a JSON cache for the UI
  and its own auto-detected ``category_key`` (different KMLs in the same project
  may group by different tags — e.g. ``amenity`` for prisons, ``landuse`` for
  cemeteries).
- ``PlacemarkAnnotation``: per-placemark user-added fields (note, source_url, …),
  keyed by ``(source_file_id, placemark_index)``.
- ``PlacemarkStyleOverride``: per-placemark category-style override (escape hatch).
- ``StylePreset``: a reusable style saved to the global library.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    category_key: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    source_files: Mapped[list["SourceFile"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="SourceFile.id"
    )
    category_styles: Mapped[list["CategoryStyle"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class SourceFile(Base):
    __tablename__ = "source_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    filename: Mapped[str] = mapped_column(String, nullable=False)
    raw_kml: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # JSON cache of parsed placemarks for fast UI loads. Source of truth is raw_kml.
    parsed_cache: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    # Auto-detected at import. Nullable to handle pre-existing rows; resolved on read.
    category_key: Mapped[str | None] = mapped_column(String, nullable=True)
    # For Overpass-generated layers: the original (un-substituted) QL the
    # investigator ran, plus the bbox (as JSON [w,s,e,n]) they targeted.
    # Both NULL on KMLs imported from disk.
    overpass_query: Mapped[str | None] = mapped_column(Text, nullable=True)
    bbox_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="source_files")
    annotations: Mapped[list["PlacemarkAnnotation"]] = relationship(
        back_populates="source_file", cascade="all, delete-orphan"
    )
    overrides: Mapped[list["PlacemarkStyleOverride"]] = relationship(
        back_populates="source_file", cascade="all, delete-orphan"
    )


class CategoryStyle(Base):
    __tablename__ = "category_styles"
    __table_args__ = (
        UniqueConstraint("project_id", "category_value", name="uq_project_category"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    category_value: Mapped[str] = mapped_column(String, nullable=False)  # e.g. "prison"
    style_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)

    project: Mapped[Project] = relationship(back_populates="category_styles")


class PlacemarkAnnotation(Base):
    __tablename__ = "placemark_annotations"
    __table_args__ = (
        UniqueConstraint(
            "source_file_id", "placemark_index", name="uq_placemark_annotation"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_file_id: Mapped[int] = mapped_column(
        ForeignKey("source_files.id", ondelete="CASCADE"), nullable=False
    )
    placemark_index: Mapped[int] = mapped_column(Integer, nullable=False)
    fields: Mapped[dict[str, str]] = mapped_column(JSON, nullable=False, default=dict)

    source_file: Mapped[SourceFile] = relationship(back_populates="annotations")


class PlacemarkStyleOverride(Base):
    __tablename__ = "placemark_style_overrides"
    __table_args__ = (
        UniqueConstraint(
            "source_file_id", "placemark_index", name="uq_placemark_override"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_file_id: Mapped[int] = mapped_column(
        ForeignKey("source_files.id", ondelete="CASCADE"), nullable=False
    )
    placemark_index: Mapped[int] = mapped_column(Integer, nullable=False)
    style_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)

    source_file: Mapped[SourceFile] = relationship(back_populates="overrides")


class StylePreset(Base):
    __tablename__ = "style_presets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    style_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
