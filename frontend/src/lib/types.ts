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

/** Truncation report attached to a SourceFile when the synthesizer hit its
 * hard cap during ingest. `total` is the full size the query would have
 * returned; `ingested` is what we actually kept; `truncated` is the
 * difference (purely for display convenience — `total - ingested`). */
export interface TruncationReport {
  total: number;
  ingested: number;
  truncated: number;
}

export interface SourceFileSummary {
  id: number;
  filename: string;
  placemark_count: number;
  category_key: string | null;
  created_at: string;
  /** Set when this SourceFile was created from a query that exceeded the
   * synthesizer cap. Imported KMLs always have `null` here. */
  truncation?: TruncationReport | null;
  /** Hostname of the Overpass mirror that served this layer, only set
   * when failover routed the request away from the primary endpoint.
   * The UI shows a muted "routed via …" footnote when present. */
  served_by?: string | null;
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
  /** First 5 entries from `tags`, kept as its own field so the domain
   * card's chip rail stays declarative. */
  top_tags: BrowseDomainTopTag[];
  /** Full categorical-tag breakdown for this domain, sorted by count
   * desc, capped at DOMAIN_TAG_CAP (200) on the backend. Drives the
   * TagBreakdownView the rail shows when the operator drills into a
   * domain card — answers "what tags actually exist in this bbox?" */
  tags: BrowseDomainTopTag[];
}

export interface BrowseInventorySummary {
  bbox: BrowseBbox;
  total_count: number;
}

/** Per-feature marker for the Browse map. Returned only when the inventory
 * isn't area-capped (capped responses come from a tags-only Overpass query
 * with no `out center;`, so positions aren't available). The backend caps
 * the list at INVENTORY_CENTER_CAP (5000) so the payload stays bounded;
 * the map clusters above 200 to keep render budget under control. */
export interface BrowseCenter {
  osm_id: string;
  lon: number;
  lat: number;
  domain: string;
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
  centers: BrowseCenter[];
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

// ── Phase L2 (large-query support) ──
// Mirrors the new preflight + tiled-inventory contracts described in the
// agent brief. The backend uses these to keep the UI from chewing on
// catastrophically-large bboxes without warning the operator first.

export type BrowsePreflightStrategy = "single" | "tiled" | "refuse";

export interface BrowseTileGrid {
  rows: number;
  cols: number;
}

/** Returned from `POST /api/browse/preflight`. The strategy controls which
 * follow-up call the UI should make:
 *   - "single" → call `browse.inventory` once.
 *   - "tiled"  → call `browse.inventoryTiled` with the supplied `tiles`.
 *   - "refuse" → don't call; surface `reason` to the user.
 * `tile_grid` and `tiles` are non-null exactly when strategy === "tiled". */
export interface BrowsePreflightResponse {
  total_count: number;
  area_km2: number;
  strategy: BrowsePreflightStrategy;
  tile_grid: BrowseTileGrid | null;
  tiles: BrowseBbox[] | null;
  reason: string | null;
}

/** Returned from `POST /api/browse/inventory-tiled`. Same shape as the
 * single-bbox inventory response plus the two tile-aggregation fields. */
export interface BrowseTiledInventoryResponse extends BrowseInventoryResponse {
  partial: boolean;
  failed_tiles: number[];
}

/** Returned from `POST /api/projects/{id}/overpass-queries/preflight`. */
export interface OverpassQueryPreflightResponse {
  total_count: number;
  estimated_kml_bytes: number;
  too_large: boolean;
  hard_cap: number;
  /** Hostname of the Overpass mirror that served the probe, only when
   * failover routed the request off the primary endpoint. */
  served_by?: string | null;
}
