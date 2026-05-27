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
