/** Adapt the API's PlacemarkPreview list into GeoJSON FeatureCollections, with
 * properties needed for the map layer's data-driven styling. */

import type { PlacemarkPreview, SourceFileDetail } from "./types";

export interface FeatureProps {
  sourceFileId: number;
  index: number;
  categoryValue: string | null;
  hasOverride: boolean;
  /** Carried in feature properties so the hover popup can show it without an
   * extra store lookup. The rest of the tag set is fetched from the store on
   * hover to avoid bloating the GeoJSON payload. */
  name: string | null;
}

// Lightweight GeoJSON shapes (we don't pull in @types/geojson to keep deps small).
interface PointFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: FeatureProps;
}
interface PolygonFeature {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: number[][][] };
  properties: FeatureProps;
}
interface LineFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: number[][] };
  properties: FeatureProps;
}

export interface Collections {
  points: { type: "FeatureCollection"; features: PointFeature[] };
  polygons: { type: "FeatureCollection"; features: PolygonFeature[] };
  lines: { type: "FeatureCollection"; features: LineFeature[] };
  bounds: [[number, number], [number, number]] | null;
}

function expand(bounds: number[] | null, lon: number, lat: number): number[] {
  if (!bounds) return [lon, lat, lon, lat];
  return [
    Math.min(bounds[0], lon),
    Math.min(bounds[1], lat),
    Math.max(bounds[2], lon),
    Math.max(bounds[3], lat),
  ];
}

export function buildCollections(
  sources: SourceFileDetail[],
): Collections {
  const points: PointFeature[] = [];
  const polygons: PolygonFeature[] = [];
  const lines: LineFeature[] = [];
  let box: number[] | null = null;

  const propsFor = (sfid: number, p: PlacemarkPreview): FeatureProps => ({
    sourceFileId: sfid,
    index: p.index,
    categoryValue: p.category_value,
    hasOverride: p.has_override,
    name:
      p.name ??
      p.extended_data["name:en"] ??
      p.extended_data["name:fr"] ??
      p.extended_data["name:ar"] ??
      null,
  });

  for (const sf of sources) {
    for (const p of sf.placemarks) {
      const g = p.geometry;
      if (!g) continue;
      if (g.kind === "Point") {
        const [lon, lat] = g.coords as [number, number];
        points.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: propsFor(sf.id, p),
        });
        box = expand(box, lon, lat);
      } else if (g.kind === "Polygon") {
        const rings = g.coords as [number, number][][];
        polygons.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: rings.map((r) => r.map((c) => [c[0], c[1]])) },
          properties: propsFor(sf.id, p),
        });
        for (const r of rings) for (const [lon, lat] of r) box = expand(box, lon, lat);
      } else if (g.kind === "LineString") {
        const coords = g.coords as [number, number][];
        lines.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords.map((c) => [c[0], c[1]]) },
          properties: propsFor(sf.id, p),
        });
        for (const [lon, lat] of coords) box = expand(box, lon, lat);
      }
    }
  }

  return {
    points: { type: "FeatureCollection", features: points },
    polygons: { type: "FeatureCollection", features: polygons },
    lines: { type: "FeatureCollection", features: lines },
    bounds: box ? [[box[0], box[1]], [box[2], box[3]]] : null,
  };
}
