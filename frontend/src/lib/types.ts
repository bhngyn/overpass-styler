/** API types — mirror the Pydantic schemas in backend/app/api/schemas.py. */

import type { RGBA } from "./kmlColor";

export type { RGBA };

export interface PolygonStyle {
  fill: boolean;
  fill_color: RGBA;
  outline: boolean;
  outline_color: RGBA;
  outline_width: number;
}

export interface IconStyle {
  icon_href: string;
  color: RGBA;
  scale: number;
  heading: number;
}

export interface LabelStyle {
  show: boolean;
  color: RGBA;
  scale: number;
}

export interface FeatureStyle {
  polygon: PolygonStyle;
  icon: IconStyle;
  label: LabelStyle;
}

export type GeometryKind = "Point" | "LineString" | "Polygon";

export interface GeometryPreview {
  kind: GeometryKind;
  coords: unknown; // Point: [lon,lat]; LineString: [[lon,lat]...]; Polygon: rings
}

export interface PlacemarkPreview {
  index: number;
  name: string | null;
  category_value: string | null;
  extended_data: Record<string, string>;
  extended_data_order: string[];
  geometry: GeometryPreview | null;
  annotations: Record<string, string>;
  has_override: boolean;
}

export interface SourceFileSummary {
  id: number;
  filename: string;
  placemark_count: number;
  category_key: string | null;
  created_at: string;
}

export interface SourceFileDetail {
  id: number;
  filename: string;
  placemark_count: number;
  category_key: string | null;
  category_counts: Record<string, number>;
  placemarks: PlacemarkPreview[];
}

export interface ProjectSummary {
  id: number;
  name: string;
  category_key: string | null;
  source_file_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectDetail {
  id: number;
  name: string;
  category_key: string | null;
  created_at: string;
  updated_at: string;
  source_files: SourceFileSummary[];
  category_styles: Record<string, FeatureStyle>;
}

export interface PresetSummary {
  id: number;
  name: string;
  style: FeatureStyle;
  is_builtin: boolean;
}

export interface IconRecord {
  id: string;
  label: string;
  href: string;
  /** Optional grouping label rendered as a divider inside the picker grid. */
  subgroup?: string | null;
}

export type IconCatalogue = Record<string, IconRecord[]>;

// ── Phase B4 (browse mode) ──
// Mirror the Pydantic schemas in backend/app/api/browse.py. WSEN bbox tuple
// is the lingua franca on the wire — convert to/from Overpass's SWNE token
// only inside the backend client.

/** [west, south, east, north] in EPSG:4326 degrees. */
export type BrowseBbox = [number, number, number, number];

export interface BrowseDomainTopTag {
  key: string;
  value: string;
  count: number;
}

export interface BrowseDomainSummary {
  name: string;
  count: number;
  top_tags: BrowseDomainTopTag[];
}

export interface BrowseInventorySummary {
  bbox: BrowseBbox;
  total_count: number;
}

/** `area_capped` toggles which of `domains` / `domain_counts` is populated.
 * In the normal mode (`false`) the rail renders per-domain cards; in capped
 * mode the rail shows a "narrow your area" hint with raw counts. */
export interface BrowseInventoryResponse {
  area_capped: boolean;
  area_km2: number;
  area_cap_km2: number;
  total_count: number;
  summary: BrowseInventorySummary | null;
  domains: BrowseDomainSummary[] | null;
  domain_counts: Record<string, number> | null;
}

export interface BrowseItemSummary {
  osm_id: string;
  name: string | null;
  tags: Record<string, string>;
  geometry_kind: string;
  center: [number, number] | null;
}

export interface BrowseItemsResponse {
  items: BrowseItemSummary[];
  has_more: boolean;
  next_offset: number;
  total: number;
}

export interface BrowseWikiLink {
  kind: string;
  label: string;
  url: string;
}

export interface BrowseFeatureGeometry {
  kind: string;
  point?: [number, number] | null;
  coordinates?: [number, number][] | null;
  members?: unknown[] | null;
}

export interface BrowseFeatureDetail {
  osm_id: string;
  name: string | null;
  tags: Record<string, string>;
  geometry: BrowseFeatureGeometry;
  wiki_links: BrowseWikiLink[];
}

export interface BrowseBakeRequest {
  project_id?: number | null;
  name?: string | null;
  bbox?: BrowseBbox | null;
  query?: string | null;
  single_osm_id?: string | null;
}

export interface BrowseBakeResponse {
  project_id: number;
  source_file: SourceFileSummary;
}
