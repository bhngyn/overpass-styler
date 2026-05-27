import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { useProjectStore } from "@/stores/project";
import { buildCollections } from "@/lib/geojson";
import { defaultFeatureStyle } from "@/lib/defaults";
import { rgbaToCss } from "@/lib/kmlColor";
import type { FeatureStyle } from "@/lib/types";

/** Basemap options.
 * - "streets" (default): Carto Voyager — sharper labels + better road hierarchy
 *   than vanilla OSM, no API key needed.
 * - "satellite": Esri World Imagery — free to use, the de-facto choice for
 *   human-rights work that needs ground-truth verification.
 * - "osm": plain OpenStreetMap raster — fallback / familiar look.
 * - "minimal": no basemap, just the page bg colour. For when tiles fail or
 *   the investigator is fully offline. */
type Basemap = "streets" | "satellite" | "osm" | "minimal";

const BASEMAP_LAYER_PREFIX = "basemap-";
const BASEMAPS: Record<Basemap, { layerId: string | null; label: string }> = {
  streets: { layerId: `${BASEMAP_LAYER_PREFIX}carto`, label: "Streets" },
  satellite: { layerId: `${BASEMAP_LAYER_PREFIX}esri`, label: "Satellite" },
  osm: { layerId: `${BASEMAP_LAYER_PREFIX}osm`, label: "OpenStreetMap" },
  minimal: { layerId: null, label: "None" },
};

const basemapStyle: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
      maxzoom: 19,
    },
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
      maxzoom: 19,
    },
    esri: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      maxzoom: 19,
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#eae6dc" } },
    {
      id: `${BASEMAP_LAYER_PREFIX}carto`,
      type: "raster",
      source: "carto",
      layout: { visibility: "visible" },
    },
    {
      id: `${BASEMAP_LAYER_PREFIX}osm`,
      type: "raster",
      source: "osm",
      layout: { visibility: "none" },
    },
    {
      id: `${BASEMAP_LAYER_PREFIX}esri`,
      type: "raster",
      source: "esri",
      layout: { visibility: "none" },
    },
  ],
};

const SOURCE_IDS = {
  polygons: "feat-polygons",
  lines: "feat-lines",
  points: "feat-points",
} as const;

const LAYER_IDS = {
  polyFill: "lyr-poly-fill",
  polyOutline: "lyr-poly-outline",
  line: "lyr-line",
  point: "lyr-point",
} as const;

const ALL_LAYER_IDS: readonly string[] = Object.values(LAYER_IDS);

export function MapPreview() {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  /** Signature of the last bounds we auto-fitted to. We only re-fit when the
   * data extent actually changes (file added/removed) — *not* on every style
   * or annotation tweak, otherwise editing a style would yank the user's
   * pan/zoom back to the data bounds every keystroke. */
  const lastFittedSigRef = useRef<string | null>(null);

  const proj = useProjectStore((s) => s.currentProject);
  const sourceFiles = useProjectStore((s) => s.sourceFiles);
  const selection = useProjectStore((s) => s.selection);
  const setSelection = useProjectStore((s) => s.setSelection);
  const hiddenCategories = useProjectStore((s) => s.hiddenCategories);
  const hiddenSourceFiles = useProjectStore((s) => s.hiddenSourceFiles);

  /** Becomes true the moment our custom sources and layers are registered with
   * the map (inside the "load" handler). Until then, setPaintProperty would
   * throw "Cannot style non-existing layer". The other effects all wait on it. */
  const [layersReady, setLayersReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<Basemap>("streets");
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  /** Single popup instance reused across hover events. Re-creating per event
   * stresses the DOM and the close animation. */
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const collections = useMemo(() => {
    const sources = proj?.source_files
      ?.map((sf) => sourceFiles[sf.id])
      .filter((d): d is NonNullable<typeof d> => Boolean(d)) ?? [];
    return buildCollections(sources);
  }, [proj, sourceFiles]);

  const categoryStyles = useMemo(() => {
    const map: Record<string, FeatureStyle> = {};
    for (const [k, v] of Object.entries(proj?.category_styles ?? {})) map[k] = v;
    return map;
  }, [proj?.category_styles]);

  // Init map once.
  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const container = ref.current;

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style: basemapStyle,
        center: [18, 13],
        zoom: 4,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");

    // MapLibre captures the container size at construction time. If the parent
    // was zero-sized on mount (it isn't anymore, but be defensive), watch and
    // resize on every container size change.
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try { map.resize(); } catch { /* ignore */ }
      });
    });
    ro.observe(container);

    map.on("error", (e) => {
      const msg = (e as { error?: Error }).error?.message ?? "unknown map error";
      setError(msg);
    });

    map.on("load", () => {
      map.resize();
      try {
        for (const id of Object.values(SOURCE_IDS)) {
          map.addSource(id, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }
        map.addLayer({
          id: LAYER_IDS.polyFill, type: "fill", source: SOURCE_IDS.polygons,
          paint: { "fill-color": "#888", "fill-opacity": 0.4 },
        });
        map.addLayer({
          id: LAYER_IDS.polyOutline, type: "line", source: SOURCE_IDS.polygons,
          paint: { "line-color": "#222", "line-width": 1.5 },
        });
        map.addLayer({
          id: LAYER_IDS.line, type: "line", source: SOURCE_IDS.lines,
          paint: { "line-color": "#222", "line-width": 2 },
        });
        map.addLayer({
          id: LAYER_IDS.point, type: "circle", source: SOURCE_IDS.points,
          paint: {
            "circle-radius": 6, "circle-color": "#fff",
            "circle-stroke-color": "#222", "circle-stroke-width": 2,
          },
        });

        const handleClick = (e: maplibregl.MapMouseEvent) => {
          const features = map.queryRenderedFeatures(e.point, {
            layers: ALL_LAYER_IDS.filter((id) => map.getLayer(id)),
          });
          if (features.length === 0) return;
          const props = features[0].properties as
            | { sourceFileId: number; index: number } | null;
          if (!props) return;
          setSelection({
            kind: "placemark",
            sourceFileId: Number(props.sourceFileId),
            placemarkIndex: Number(props.index),
          });
        };
        map.on("click", handleClick);

        // Hover popup + cursor change. One handler per geometry layer because
        // MapLibre dispatches mousemove per layer, not globally.
        const popup = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 10,
          maxWidth: "300px",
          className: "feature-hover-popup",
        });
        popupRef.current = popup;

        const showPopup = (e: maplibregl.MapLayerMouseEvent) => {
          const feat = e.features?.[0];
          if (!feat) return;
          map.getCanvas().style.cursor = "pointer";
          const html = buildPopupHtml(feat.properties as Record<string, unknown>);
          // Anchor at the point's own coords for points; at cursor for polygons.
          let anchor: maplibregl.LngLatLike = e.lngLat;
          if (feat.geometry.type === "Point") {
            const coords = (feat.geometry as unknown as { coordinates: number[] }).coordinates;
            if (coords.length >= 2) anchor = [coords[0], coords[1]];
          }
          popup.setLngLat(anchor).setHTML(html).addTo(map);
        };
        const hidePopup = () => {
          map.getCanvas().style.cursor = "";
          popup.remove();
        };

        for (const layerId of [LAYER_IDS.polyFill, LAYER_IDS.point, LAYER_IDS.line]) {
          map.on("mousemove", layerId, showPopup);
          map.on("mouseleave", layerId, hidePopup);
        }

        setLayersReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

    mapRef.current = map;
    return () => {
      ro.disconnect();
      try { map.remove(); } catch { /* ignore */ }
      mapRef.current = null;
      setLayersReady(false);
    };
  }, [setSelection]);

  // Push GeoJSON into the sources whenever the collections change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    try {
      (map.getSource(SOURCE_IDS.polygons) as maplibregl.GeoJSONSource | undefined)
        ?.setData(collections.polygons);
      (map.getSource(SOURCE_IDS.lines) as maplibregl.GeoJSONSource | undefined)
        ?.setData(collections.lines);
      (map.getSource(SOURCE_IDS.points) as maplibregl.GeoJSONSource | undefined)
        ?.setData(collections.points);

      // Only auto-fit when the bounds actually change. Comparing a short
      // signature string keeps the check cheap and stable across React's many
      // re-render reasons (style edits, annotation saves, selection moves).
      const sig = collections.bounds
        ? `${collections.bounds[0].join(",")}|${collections.bounds[1].join(",")}`
        : null;
      if (collections.bounds && sig !== lastFittedSigRef.current) {
        map.fitBounds(collections.bounds, { padding: 60, animate: false, maxZoom: 12 });
        lastFittedSigRef.current = sig;
      } else if (sig === null) {
        // No data → forget the last fit so a future import re-fits.
        lastFittedSigRef.current = null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [collections, layersReady]);

  // Category-style paint updates.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;

    const fillColorExpr = buildMatchExpression(categoryStyles, (s) => rgbaToCss(s.polygon.fill_color), rgbaToCss(defaultFeatureStyle().polygon.fill_color));
    const fillOpacityExpr = buildMatchExpression(categoryStyles, (s) => (s.polygon.fill ? 1 : 0), 0.4);
    const outlineColorExpr = buildMatchExpression(categoryStyles, (s) => rgbaToCss(s.polygon.outline_color), rgbaToCss(defaultFeatureStyle().polygon.outline_color));
    const outlineWidthExpr = buildMatchExpression(categoryStyles, (s) => (s.polygon.outline ? s.polygon.outline_width : 0), 1.5);
    const pointFillExpr = buildMatchExpression(categoryStyles, (s) => rgbaToCss(s.icon.color), "#fff");
    const pointStrokeExpr = buildMatchExpression(categoryStyles, (s) => rgbaToCss(s.polygon.outline_color), "#222");

    safeSetPaint(map, LAYER_IDS.polyFill, "fill-color", fillColorExpr);
    safeSetPaint(map, LAYER_IDS.polyFill, "fill-opacity", fillOpacityExpr);
    safeSetPaint(map, LAYER_IDS.polyOutline, "line-color", outlineColorExpr);
    safeSetPaint(map, LAYER_IDS.polyOutline, "line-width", outlineWidthExpr);
    safeSetPaint(map, LAYER_IDS.point, "circle-color", pointFillExpr);
    safeSetPaint(map, LAYER_IDS.point, "circle-stroke-color", pointStrokeExpr);
  }, [categoryStyles, layersReady]);

  // Selection-driven highlight.
  // Deliberately *non-destructive*: we never dim non-selected features, so the
  // investigator always sees the full picture. The selected category/source-
  // file gets a thicker outline + larger point radius — a clear signal without
  // hiding context. Use the eye toggles in the tree for actual hide/show.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;

    const baseOutlineWidth = buildMatchExpression(
      categoryStyles,
      (s) => (s.polygon.outline ? s.polygon.outline_width : 0),
      1.5,
    );
    const baseCircleRadius: unknown = 6;

    if (selection.kind === "category") {
      // Bump outline width and circle radius for matching features.
      safeSetPaint(map, LAYER_IDS.polyOutline, "line-width", [
        "case",
        ["==", ["get", "categoryValue"], selection.categoryValue],
        ["+", baseOutlineWidth, 2.5],
        baseOutlineWidth,
      ]);
      safeSetPaint(map, LAYER_IDS.point, "circle-radius", [
        "case",
        ["==", ["get", "categoryValue"], selection.categoryValue],
        9,
        baseCircleRadius,
      ]);
    } else if (selection.kind === "source") {
      safeSetPaint(map, LAYER_IDS.polyOutline, "line-width", [
        "case",
        ["==", ["get", "sourceFileId"], selection.sourceFileId],
        ["+", baseOutlineWidth, 2.5],
        baseOutlineWidth,
      ]);
      safeSetPaint(map, LAYER_IDS.point, "circle-radius", [
        "case",
        ["==", ["get", "sourceFileId"], selection.sourceFileId],
        9,
        baseCircleRadius,
      ]);
    } else if (selection.kind === "placemark") {
      // Pan to the placemark and emphasise it.
      safeSetPaint(map, LAYER_IDS.point, "circle-radius", [
        "case",
        [
          "all",
          ["==", ["get", "sourceFileId"], selection.sourceFileId],
          ["==", ["get", "index"], selection.placemarkIndex],
        ],
        11,
        baseCircleRadius,
      ]);
      safeSetPaint(map, LAYER_IDS.polyOutline, "line-width", [
        "case",
        [
          "all",
          ["==", ["get", "sourceFileId"], selection.sourceFileId],
          ["==", ["get", "index"], selection.placemarkIndex],
        ],
        ["+", baseOutlineWidth, 2.5],
        baseOutlineWidth,
      ]);
      flyToPlacemark(map, selection.sourceFileId, selection.placemarkIndex);
    } else {
      // Reset to base.
      safeSetPaint(map, LAYER_IDS.polyOutline, "line-width", baseOutlineWidth);
      safeSetPaint(map, LAYER_IDS.point, "circle-radius", baseCircleRadius);
    }
  }, [selection, categoryStyles, layersReady]);

  // Basemap switch — toggle visibility of each raster layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const applyBasemap = () => {
      for (const cfg of Object.values(BASEMAPS)) {
        if (cfg.layerId && map.getLayer(cfg.layerId)) {
          map.setLayoutProperty(cfg.layerId, "visibility", "none");
        }
      }
      const target = BASEMAPS[basemap].layerId;
      if (target && map.getLayer(target)) {
        map.setLayoutProperty(target, "visibility", "visible");
      }
    };
    if (map.isStyleLoaded()) applyBasemap();
    else map.once("load", applyBasemap);
  }, [basemap]);

  // Visibility filters — hide categories/source files toggled off in the tree.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const hidCats = Array.from(hiddenCategories);
    const hidSfs = Array.from(hiddenSourceFiles);

    const filter: unknown = [
      "all",
      hidCats.length > 0
        ? ["!", ["in", ["get", "categoryValue"], ["literal", hidCats]]]
        : true,
      hidSfs.length > 0
        ? ["!", ["in", ["get", "sourceFileId"], ["literal", hidSfs]]]
        : true,
    ];

    for (const id of ALL_LAYER_IDS) {
      if (!map.getLayer(id)) continue;
      try {
        map.setFilter(id, filter as maplibregl.FilterSpecification);
      } catch {
        /* ignore */
      }
    }
  }, [hiddenCategories, hiddenSourceFiles, layersReady]);

  // Helper used by the placemark-selection branch above. Defined inline so it
  // can read fresh `sourceFiles` via the store without redoing dep arrays.
  function flyToPlacemark(map: MapLibreMap, sfid: number, idx: number) {
    const detail = useProjectStore.getState().sourceFiles[sfid];
    const pm = detail?.placemarks.find((p) => p.index === idx);
    const g = pm?.geometry;
    if (!g) return;
    let lon: number | null = null;
    let lat: number | null = null;
    if (g.kind === "Point") {
      [lon, lat] = g.coords as [number, number];
    } else if (g.kind === "Polygon") {
      const rings = g.coords as [number, number][][];
      const first = rings[0]?.[0];
      if (first) [lon, lat] = first;
    } else if (g.kind === "LineString") {
      const coords = g.coords as [number, number][];
      if (coords[0]) [lon, lat] = coords[0];
    }
    if (lon == null || lat == null) return;
    map.flyTo({
      center: [lon, lat],
      zoom: Math.max(map.getZoom(), 10),
      speed: 1.2,
      essential: true,
    });
  }

  const fitToData = () => {
    const map = mapRef.current;
    if (!map || !collections.bounds) return;
    map.fitBounds(collections.bounds, { padding: 60, animate: true, maxZoom: 12 });
  };

  return (
    <>
      <div
        ref={ref}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
      {/* Basemap switcher — bottom-right above the maplibre attribution. */}
      <div className="absolute bottom-7 right-3 flex overflow-hidden rounded-md border border-[var(--color-line)] bg-white/95 text-xs shadow-sm">
        {(Object.entries(BASEMAPS) as [Basemap, typeof BASEMAPS[Basemap]][]).map(
          ([key, cfg]) => (
            <button
              key={key}
              type="button"
              onClick={() => setBasemap(key)}
              className={[
                "border-l border-[var(--color-line)] px-2 py-1 first:border-l-0",
                basemap === key
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]",
              ].join(" ")}
            >
              {cfg.label}
            </button>
          ),
        )}
      </div>

      {/* Fit-to-data button — left of the legend. */}
      {collections.bounds && (
        <button
          type="button"
          onClick={fitToData}
          title="Fit map to all features"
          className="absolute bottom-3 left-3 rounded-md border border-[var(--color-line)] bg-white/95 px-2.5 py-1.5 text-xs text-[var(--color-ink-soft)] shadow-sm hover:text-[var(--color-ink)]"
        >
          Fit to data
        </button>
      )}

      {/* Legend — top-right, collapsible. */}
      <Legend collapsed={legendCollapsed} onToggle={() => setLegendCollapsed((c) => !c)} />

      {error && (
        <div
          role="alert"
          className="absolute left-2 top-2 max-w-xs rounded-md border border-[var(--color-danger)]/40 bg-white/95 px-3 py-2 text-xs text-[var(--color-danger)] shadow-sm"
        >
          <div className="font-medium uppercase tracking-wider text-[10px]">Map error</div>
          <div className="mt-0.5">{error}</div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="mt-1 text-[10px] underline opacity-70 hover:opacity-100"
          >
            dismiss
          </button>
        </div>
      )}
    </>
  );
}

/** Set a paint property without throwing if the layer or expression is invalid.
 * MapLibre's `setPaintProperty` is unforgiving about timing — guarding here is
 * cheaper than racing every caller. */
function safeSetPaint(
  map: MapLibreMap,
  layerId: string,
  property: string,
  value: unknown,
): void {
  if (!map.getLayer(layerId)) return;
  try {
    map.setPaintProperty(layerId, property, value);
  } catch {
    /* swallow — paint update racing layer teardown isn't worth surfacing */
  }
}

function buildMatchExpression<T>(
  styles: Record<string, FeatureStyle>,
  pick: (s: FeatureStyle) => T,
  fallback: T,
): unknown {
  const entries = Object.entries(styles);
  if (entries.length === 0) return fallback;
  const expr: unknown[] = ["match", ["get", "categoryValue"]];
  for (const [value, style] of entries) {
    expr.push(value, pick(style));
  }
  expr.push(fallback);
  return expr;
}

/** OSM tag keys not worth showing in the hover popup — administrivia, IDs,
 * notes-to-self that mappers leave behind. */
const POPUP_SKIP_KEYS = new Set([
  "@id", "type", "fixme", "note", "source",
]);
const POPUP_SKIP_PREFIXES = ["project:", "ref:", "wikipedia", "wikidata"];

function isSkippedKey(k: string): boolean {
  if (POPUP_SKIP_KEYS.has(k)) return true;
  return POPUP_SKIP_PREFIXES.some((p) => k === p.replace(/:$/, "") || k.startsWith(p));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the inner HTML for a hover popup from a feature's properties + the
 * full placemark record looked up from the store. */
function buildPopupHtml(props: Record<string, unknown>): string {
  const sfid = Number(props.sourceFileId);
  const index = Number(props.index);
  const state = useProjectStore.getState();
  const proj = state.currentProject;
  const detail = state.sourceFiles[sfid];
  const placemark = detail?.placemarks.find((p) => p.index === index);
  if (!placemark || !detail) return "";

  const propName = typeof props.name === "string" && props.name ? props.name : null;
  const displayName =
    propName ?? placemark.name ?? `Placemark #${placemark.index}`;
  const categoryKey = detail.category_key ?? proj?.category_key ?? null;
  const categoryValue = placemark.category_value;

  const visibleTags = placemark.extended_data_order
    .filter((k) => !isSkippedKey(k))
    .filter((k) => !(categoryKey && k === categoryKey)) // shown above as the badge
    .filter((k) => !k.startsWith("name")) // name already in heading
    .filter((k) => placemark.extended_data[k])
    .slice(0, 5);

  const annotations = Object.entries(placemark.annotations).filter(([, v]) => v);

  const rows = visibleTags
    .map(
      (k) => `
      <div style="display:grid;grid-template-columns:max-content 1fr;gap:0 8px;">
        <code style="color:var(--color-ink-faint);font-size:10px;">${escapeHtml(k)}</code>
        <span style="font-size:11px;">${escapeHtml(placemark.extended_data[k])}</span>
      </div>`,
    )
    .join("");

  const annotationRows = annotations
    .map(
      ([k, v]) => `
      <div style="display:grid;grid-template-columns:max-content 1fr;gap:0 8px;">
        <code style="color:var(--color-success);font-size:10px;">${escapeHtml(k)}</code>
        <span style="font-size:11px;">${escapeHtml(v)}</span>
      </div>`,
    )
    .join("");

  return `
    <div style="font-family:var(--font-body);color:var(--color-ink);min-width:200px;">
      <div style="font-weight:600;font-size:13px;margin-bottom:2px;">${escapeHtml(displayName)}</div>
      ${
        categoryValue && categoryKey
          ? `<div style="margin-bottom:6px;"><code style="font-size:11px;color:var(--color-accent);">${escapeHtml(categoryKey)}=${escapeHtml(categoryValue)}</code></div>`
          : ""
      }
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-ink-faint);margin-bottom:2px;">${escapeHtml(detail.filename)}</div>
      ${rows ? `<div style="margin-top:6px;display:flex;flex-direction:column;gap:2px;">${rows}</div>` : ""}
      ${
        annotationRows
          ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--color-line);display:flex;flex-direction:column;gap:2px;">
               <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-ink-faint);">Annotations</div>
               ${annotationRows}
             </div>`
          : ""
      }
    </div>
  `;
}

/** Legend — top-right floating panel that lists every category visible in
 * the project, with its swatch and feature count. Click a swatch to toggle
 * visibility (mirrors the eye toggles in the tree). */
function Legend({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const proj = useProjectStore((s) => s.currentProject);
  const sourceFiles = useProjectStore((s) => s.sourceFiles);
  const hiddenCategories = useProjectStore((s) => s.hiddenCategories);
  const hiddenSourceFiles = useProjectStore((s) => s.hiddenSourceFiles);
  const toggleCategoryVisible = useProjectStore((s) => s.toggleCategoryVisible);
  const styleForCategory = useProjectStore((s) => s.styleForCategory);

  if (!proj) return null;

  // Group categories by source file so the legend reads as a hierarchy.
  const groups = proj.source_files
    .map((sf) => {
      const detail = sourceFiles[sf.id];
      if (!detail) return null;
      const entries = Object.entries(detail.category_counts).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) return null;
      return {
        sf,
        entries,
        hidden: hiddenSourceFiles.has(sf.id),
      };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null);

  if (groups.length === 0) return null;

  return (
    <div className="absolute right-3 top-3 max-w-xs rounded-md border border-[var(--color-line)] bg-white/95 text-xs shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
      >
        <span>Legend</span>
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[60vh] overflow-y-auto px-3 pb-3">
          {groups.map(({ sf, entries, hidden }) => (
            <div key={sf.id} className="mt-1 space-y-0.5">
              <div
                className={[
                  "truncate text-[11px] font-medium",
                  hidden ? "opacity-50" : "",
                ].join(" ")}
                title={sf.filename}
              >
                {sf.filename}
              </div>
              <div className="space-y-0.5">
                {entries.map(([value, count]) => {
                  const style = styleForCategory(value);
                  const isHidden = hidden || hiddenCategories.has(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => toggleCategoryVisible(value)}
                      title={isHidden ? `Show ${value}` : `Hide ${value}`}
                      className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-[var(--color-surface-sunken)]"
                    >
                      <span
                        className="block h-3 w-3 shrink-0 rounded-sm border"
                        style={{
                          backgroundColor: rgbaToCss(style.polygon.fill_color),
                          borderColor: rgbaToCss(style.polygon.outline_color),
                          opacity: isHidden ? 0.25 : 1,
                        }}
                      />
                      <span
                        className={[
                          "truncate font-[var(--font-mono)] text-[11px]",
                          isHidden ? "text-[var(--color-ink-faint)] line-through" : "text-[var(--color-ink)]",
                        ].join(" ")}
                      >
                        {value}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--color-ink-faint)]">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="mt-2 border-t border-[var(--color-line)] pt-1.5 text-[10px] text-[var(--color-ink-faint)]">
            Click a swatch to hide/show that layer on the map.
          </div>
        </div>
      )}
    </div>
  );
}
