"""Pydantic API schemas. Mirror the SQLAlchemy models but are the public contract
shared with the TypeScript frontend (the frontend generates its types from these).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

ColorChannel = Annotated[int, Field(ge=0, le=255)]


class RGBASchema(BaseModel):
    r: ColorChannel
    g: ColorChannel
    b: ColorChannel
    a: ColorChannel = 255


class PolygonStyleSchema(BaseModel):
    fill: bool = True
    fill_color: RGBASchema
    outline: bool = True
    outline_color: RGBASchema
    outline_width: float = 1.5


class IconStyleSchema(BaseModel):
    icon_href: str
    color: RGBASchema
    scale: float = 1.0
    heading: float = 0.0


class LabelStyleSchema(BaseModel):
    show: bool = True
    color: RGBASchema
    scale: float = 1.0


class FeatureStyleSchema(BaseModel):
    polygon: PolygonStyleSchema
    icon: IconStyleSchema
    label: LabelStyleSchema


class GeometryPreview(BaseModel):
    """Lightweight geometry payload for the map preview."""

    kind: Literal["Point", "LineString", "Polygon"]
    # For Point: [lon, lat]; for LineString: [[lon,lat], ...]; for Polygon: [outer, *inners] where each ring is [[lon,lat], ...]
    coords: list  # type: ignore[type-arg]


class PlacemarkPreview(BaseModel):
    index: int
    name: str | None
    category_value: str | None
    extended_data: dict[str, str]
    extended_data_order: list[str]
    geometry: GeometryPreview | None
    annotations: dict[str, str] = Field(default_factory=dict)
    has_override: bool = False


class TruncationReportSchema(BaseModel):
    """Surfaced on SourceFileSummary when the synthesizer hit its cap.

    The shape matches L2's frontend contract: ``total`` is what Overpass
    returned, ``ingested`` is what we kept, ``truncated`` is the *count* of
    dropped elements (``total - ingested``) — so the UI can say "dropped
    23,471 of 73,471 features" without doing the arithmetic itself.
    """

    total: int
    ingested: int
    truncated: int


class SourceFileSummary(BaseModel):
    id: int
    filename: str
    placemark_count: int
    category_key: str | None
    created_at: datetime
    # Provenance for query-derived layers — the original QL the investigator
    # authored (with ``{{bbox}}`` un-substituted) and the bbox they targeted.
    # Both null for KML uploads. The frontend uses these to render a small
    # "from query" pip in the layer tree and to power the "re-run query"
    # affordance D3 flagged.
    overpass_query: str | None = None
    bbox_json: str | None = None
    # Populated only on Overpass-query layers where the synthesizer hit its
    # hard cap. Imported KMLs always serialise this as ``null``.
    truncation: TruncationReportSchema | None = None
    model_config = ConfigDict(from_attributes=True)


class ProjectSummary(BaseModel):
    id: int
    name: str
    category_key: str | None
    source_file_count: int
    created_at: datetime
    updated_at: datetime


class ProjectDetail(BaseModel):
    id: int
    name: str
    category_key: str | None
    created_at: datetime
    updated_at: datetime
    source_files: list[SourceFileSummary]
    category_styles: dict[str, FeatureStyleSchema]  # category_value -> style


class SourceFileDetail(BaseModel):
    id: int
    filename: str
    placemark_count: int
    category_key: str | None
    category_counts: dict[str, int]
    placemarks: list[PlacemarkPreview]
    # Same provenance fields as SourceFileSummary — present on detail too so
    # the inspector can show "re-run this query" without a second round-trip.
    overpass_query: str | None = None
    bbox_json: str | None = None


class CreateProjectRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class UpdateProjectRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    category_key: str | None = Field(default=None, max_length=200)


class SetCategoryStyleRequest(BaseModel):
    style: FeatureStyleSchema


class AnnotationUpdate(BaseModel):
    fields: dict[str, str]


class OverrideUpdate(BaseModel):
    style: FeatureStyleSchema | None  # null clears the override


class PresetSummary(BaseModel):
    id: int
    name: str
    style: FeatureStyleSchema
    is_builtin: bool


class CreatePresetRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    style: FeatureStyleSchema


class EnrichOSMResponse(BaseModel):
    tags: dict[str, str]
    fetched_at: datetime


class ReverseGeocodeResponse(BaseModel):
    address: dict[str, str]
    display_name: str
    fetched_at: datetime
