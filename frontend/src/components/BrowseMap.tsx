/**
 * BrowseMap — slim MapLibre wrapper for the Field Atlas (Browse mode).
 *
 * NOTE: this is a parallel implementation of the map setup used by MapPreview
 * (basemap config, container sizing, ResizeObserver). The two were forked for
 * v1 because their feature surfaces diverge sharply — BrowseMap renders a
 * uniform muted-ink reconnaissance layer (no category styling, no
 * selection-driven popups, no fly-to-data) and overlays the bbox of interest.
 * A future consolidation pass should extract a shared <MapShell> primitive
 * that both modes mount on top of so basemap improvements only need to land
 * once. Until then: keep the basemap config in sync by hand.
 *
 * Render contract:
 * - Renders inventory items as muted-ink dots.
 * - Hovered item lights up in accent color.
 * - The currently-selected bbox is drawn as a teal rectangle with a
 *   translucent darken overlay on the rest of the world.
 * - Clicking a feature emits onFeatureClick(osmId).
 * - Parent can ref the component and call getViewportBbox() to capture the
 *   current visible bounds (used by the "Use current viewport" button).
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import type { BrowseBbox, BrowseItemSummary } from "@/lib/types";

type Basemap = "streets" | "satellite" | "osm" | "minimal";

const BASEMAP_LAYER_PREFIX = "basemap-";
const BASEMAPS: Record<Basemap, { layerId: string | null; label: string }> = {
  streets: { layerId: `${BASEMAP_LAYER_PREFIX}carto`, label: "Streets" },
  satellite: { layerId: `${BASEMAP_LAYER_PREFIX}esri`, label: "Satellite" },
  osm: { layerId: `${BASEMAP_LAYER_PREFIX}osm`, label: "OSM" },
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
  bboxFill: "browse-bbox-fill",
  bboxOutline: "browse-bbox-outline",
  items: "browse-items",
  tileGrid: "browse-tile-grid",
} as const;

const LAYER_IDS = {
  bboxMask: "browse-bbox-mask",
  bboxOutline: "browse-bbox-outline",
  items: "browse-items",
  itemsHighlight: "browse-items-highlight",
  clusters: "browse-clusters",
  clusterCounts: "browse-cluster-counts",
  tileGridFill: "browse-tile-grid-fill",
  tileGridOutline: "browse-tile-grid-outline",
} as const;

// Threshold at which we flip the items source over to clustering. Below
// this, individual dots are still legible at typical zoom levels; above
// it, dots overlap into a blob and we get more value from cluster bubbles.
const CLUSTER_THRESHOLD = 200;

export interface BrowseMapHandle {
  /** Read the current visible bounds. Returns null if the map hasn't
   * finished mounting yet. */
  getViewportBbox: () => BrowseBbox | null;
  /** Fly the map to a bbox without setting it as the "selected" bbox
   * (used by the search-to-place flow before the user commits). */
  flyToBbox: (bbox: BrowseBbox) => void;
}

/** Tile-grid overlay descriptor. Set when the parent's preflight decided
 * the bbox should be tiled — we render the grid as a faint outline so the
 * operator can watch the inventory fetch fill in. `loadedTiles` /
 * `totalTiles` drive the legend in the bottom-left corner. The grid is
 * fixed-shape (rows × cols) for v1; the L1 backend already snaps tiles
 * onto a regular grid, so we don't need per-tile bboxes for the overlay. */
export interface TileGridState {
  rows: number;
  cols: number;
  bbox: BrowseBbox;
  loadedTiles: number;
  totalTiles: number;
}

interface Props {
  bbox: BrowseBbox | null;
  items: BrowseItemSummary[];
  hoveredOsmId: string | null;
  selectedOsmId: string | null;
  onFeatureClick: (osmId: string) => void;
  tileGrid?: TileGridState | null;
}

export const BrowseMap = forwardRef<BrowseMapHandle, Props>(function BrowseMap(
  { bbox, items, hoveredOsmId, selectedOsmId, onFeatureClick, tileGrid },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onClickRef = useRef(onFeatureClick);
  onClickRef.current = onFeatureClick;

  const [layersReady, setLayersReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<Basemap>("streets");
  /** Track the last bbox we auto-fitted to so we don't yank the user's
   * pan/zoom every time items load. */
  const lastFittedBboxRef = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({
    getViewportBbox: () => {
      const map = mapRef.current;
      if (!map) return null;
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    },
    flyToBbox: (b) => {
      const map = mapRef.current;
      if (!map) return;
      try {
        map.fitBounds(
          [
            [b[0], b[1]],
            [b[2], b[3]],
          ],
          { padding: 60, animate: true, maxZoom: 14 },
        );
      } catch {
        /* ignore — invalid bbox */
      }
    },
  }));

  // Mount + teardown the MapLibre instance once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const container = containerRef.current;

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style: basemapStyle,
        center: [18, 13],
        zoom: 2.5,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");

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
        map.addSource(SOURCE_IDS.bboxFill, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addSource(SOURCE_IDS.bboxOutline, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        // The items source is added/removed by the cluster-toggle effect
        // (clustering needs a fresh source recreate), so we don't add it
        // here.
        map.addSource(SOURCE_IDS.tileGrid, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        map.addLayer({
          id: LAYER_IDS.bboxMask,
          type: "fill",
          source: SOURCE_IDS.bboxFill,
          paint: {
            "fill-color": "#1f2933",
            "fill-opacity": 0.18,
          },
        });
        map.addLayer({
          id: LAYER_IDS.bboxOutline,
          type: "line",
          source: SOURCE_IDS.bboxOutline,
          paint: {
            "line-color": "#2a5d6b",
            "line-width": 2,
            "line-dasharray": [3, 2],
          },
        });
        // Tile-grid overlay layers — fill is faintly accent-tinted for
        // loaded cells (driven by a per-feature `state` property) and a
        // line layer draws the cell outlines for not-yet-loaded cells.
        map.addLayer({
          id: LAYER_IDS.tileGridFill,
          type: "fill",
          source: SOURCE_IDS.tileGrid,
          paint: {
            "fill-color": [
              "match",
              ["get", "state"],
              "loaded",
              "#2a5d6b",
              "pending",
              "#2a5d6b",
              "#000000",
            ],
            "fill-opacity": [
              "match",
              ["get", "state"],
              "loaded",
              0.14,
              "pending",
              0.06,
              0.0,
            ],
          },
        });
        map.addLayer({
          id: LAYER_IDS.tileGridOutline,
          type: "line",
          source: SOURCE_IDS.tileGrid,
          paint: {
            "line-color": "#2a5d6b",
            "line-width": 0.5,
            "line-opacity": 0.45,
          },
        });

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
  }, []);

  // Push the bbox mask + outline whenever the bbox changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;

    const fillSource = map.getSource(SOURCE_IDS.bboxFill) as
      | maplibregl.GeoJSONSource
      | undefined;
    const outlineSource = map.getSource(SOURCE_IDS.bboxOutline) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!fillSource || !outlineSource) return;

    if (!bbox) {
      fillSource.setData({ type: "FeatureCollection", features: [] });
      outlineSource.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const [w, s, e, n] = bbox;
    // Outer ring spans the whole world; inner ring is the bbox. A polygon
    // with two rings = fill with a hole — so the world *outside* the bbox
    // darkens, the bbox itself stays bright.
    const outerRing: [number, number][] = [
      [-180, -85],
      [180, -85],
      [180, 85],
      [-180, 85],
      [-180, -85],
    ];
    const innerRing: [number, number][] = [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ];
    fillSource.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [outerRing, innerRing],
          },
        },
      ],
    });
    outlineSource.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: innerRing,
          },
        },
      ],
    });

    const sig = bbox.join(",");
    if (sig !== lastFittedBboxRef.current) {
      try {
        map.fitBounds(
          [
            [w, s],
            [e, n],
          ],
          { padding: 60, animate: true, maxZoom: 14 },
        );
        lastFittedBboxRef.current = sig;
      } catch {
        /* ignore */
      }
    }
  }, [bbox, layersReady]);

  // Convert inventory items into a GeoJSON FeatureCollection of points.
  const itemsGeojson = useMemo(() => {
    const features: GeoJSON.Feature[] = [];
    for (const it of items) {
      if (!it.center) continue;
      features.push({
        type: "Feature",
        properties: {
          osm_id: it.osm_id,
          name: it.name ?? "",
          kind: it.geometry_kind,
        },
        geometry: {
          type: "Point",
          coordinates: [it.center[0], it.center[1]],
        },
      });
    }
    return { type: "FeatureCollection" as const, features };
  }, [items]);

  // Clustering on/off is decided per-render based on how many items we have.
  // Toggling `cluster` on a live GeoJSONSource isn't supported by MapLibre,
  // so we tear down + re-add the source (and its dependent layers) every
  // time the flag flips. This effect also owns the click/cursor handlers
  // because they're tied to the layers it builds.
  const clusterMode = items.length >= CLUSTER_THRESHOLD;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;

    // Tear down any prior items source + layers. Order matters — remove
    // layers before sources.
    for (const id of [
      LAYER_IDS.itemsHighlight,
      LAYER_IDS.items,
      LAYER_IDS.clusters,
      LAYER_IDS.clusterCounts,
    ]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(SOURCE_IDS.items)) map.removeSource(SOURCE_IDS.items);

    map.addSource(SOURCE_IDS.items, {
      type: "geojson",
      data: itemsGeojson,
      cluster: clusterMode,
      clusterRadius: 40,
      clusterMaxZoom: 14,
    });

    if (clusterMode) {
      // Cluster bubbles — radius scales with point_count.
      map.addLayer({
        id: LAYER_IDS.clusters,
        type: "circle",
        source: SOURCE_IDS.items,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#2a5d6b",
          "circle-opacity": 0.7,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-radius": [
            "step",
            ["get", "point_count"],
            14,
            25,
            18,
            100,
            24,
            500,
            30,
            2000,
            36,
          ],
        },
      });
      map.addLayer({
        id: LAYER_IDS.clusterCounts,
        type: "symbol",
        source: SOURCE_IDS.items,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 11,
        },
        paint: {
          "text-color": "#ffffff",
        },
      });
    }

    // Singleton points — visible in both modes, but only on un-clustered
    // features in cluster mode (the `!has point_count` filter).
    map.addLayer({
      id: LAYER_IDS.items,
      type: "circle",
      source: SOURCE_IDS.items,
      filter: clusterMode ? ["!", ["has", "point_count"]] : ["all"],
      paint: {
        "circle-radius": 4.5,
        "circle-color": "#4a5a66",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1,
        "circle-opacity": 0.85,
      },
    });
    map.addLayer({
      id: LAYER_IDS.itemsHighlight,
      type: "circle",
      source: SOURCE_IDS.items,
      paint: {
        "circle-radius": 8,
        "circle-color": "#2a5d6b",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
        "circle-opacity": 1,
      },
      filter: ["==", ["get", "osm_id"], "__none__"],
    });

    // Click → either zoom into the cluster or emit the osm_id.
    function onItemClick(e: maplibregl.MapLayerMouseEvent) {
      const f = e.features?.[0];
      if (!f) return;
      const osmId = f.properties?.osm_id as string | undefined;
      if (osmId) onClickRef.current(osmId);
    }
    map.on("click", LAYER_IDS.items, onItemClick);

    const mapForCluster = map;
    function onClusterClick(e: maplibregl.MapLayerMouseEvent) {
      const f = e.features?.[0];
      if (!f) return;
      const clusterId = f.properties?.cluster_id;
      const source = mapForCluster.getSource(SOURCE_IDS.items) as
        | (maplibregl.GeoJSONSource & {
            getClusterExpansionZoom: (
              id: number,
              cb: (err: Error | null, zoom: number) => void,
            ) => void;
          })
        | undefined;
      if (!source || clusterId == null) return;
      source.getClusterExpansionZoom(clusterId as number, (err, zoom) => {
        if (err) return;
        const geom = f.geometry as GeoJSON.Point;
        mapForCluster.easeTo({
          center: geom.coordinates as [number, number],
          zoom,
        });
      });
    }

    if (clusterMode) {
      map.on("click", LAYER_IDS.clusters, onClusterClick);
      map.on("mouseenter", LAYER_IDS.clusters, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", LAYER_IDS.clusters, () => {
        map.getCanvas().style.cursor = "";
      });
    }

    map.on("mouseenter", LAYER_IDS.items, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", LAYER_IDS.items, () => {
      map.getCanvas().style.cursor = "";
    });

    return () => {
      // Clean up handlers in case the next render re-adds them.
      try {
        map.off("click", LAYER_IDS.items, onItemClick);
        if (clusterMode) map.off("click", LAYER_IDS.clusters, onClusterClick);
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layersReady, clusterMode]);

  // Push fresh data through the source (keeps cluster index up to date).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const src = map.getSource(SOURCE_IDS.items) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(itemsGeojson);
  }, [itemsGeojson, layersReady]);

  // Highlight the hovered / selected feature via a filter on the second layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const target = hoveredOsmId ?? selectedOsmId ?? "__none__";
    try {
      map.setFilter(LAYER_IDS.itemsHighlight, [
        "==",
        ["get", "osm_id"],
        target,
      ]);
    } catch {
      /* ignore */
    }
  }, [hoveredOsmId, selectedOsmId, layersReady]);

  // Tile-grid overlay — paint rows × cols cells onto the bbox, tinting
  // already-loaded cells. We approximate "loaded" by the loadedTiles
  // counter, walking row-major from the top-left. The L1 backend hands
  // back tiles in the same order, so this matches what's actually being
  // fetched without us having to track per-tile bboxes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const src = map.getSource(SOURCE_IDS.tileGrid) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!src) return;
    if (!tileGrid) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const { rows, cols, bbox: tg, loadedTiles } = tileGrid;
    const [w, s, e, n] = tg;
    const lonStep = (e - w) / cols;
    const latStep = (n - s) / rows;
    const features: GeoJSON.Feature[] = [];
    let idx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellW = w + c * lonStep;
        const cellE = w + (c + 1) * lonStep;
        // Rows are top-down (north → south) so the first row index is
        // closest to `n`.
        const cellN = n - r * latStep;
        const cellS = n - (r + 1) * latStep;
        let state: "loaded" | "pending" | "idle" = "idle";
        if (idx < loadedTiles) state = "loaded";
        else if (idx === loadedTiles) state = "pending";
        features.push({
          type: "Feature",
          properties: { idx, state },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [cellW, cellS],
                [cellE, cellS],
                [cellE, cellN],
                [cellW, cellN],
                [cellW, cellS],
              ],
            ],
          },
        });
        idx++;
      }
    }
    src.setData({ type: "FeatureCollection", features });
  }, [tileGrid, layersReady]);

  // Basemap toggle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
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
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [basemap]);

  return (
    <>
      <div
        ref={containerRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
      {/* Tile-grid legend — only shown while a tiled fetch is in flight.
          We hide it once loadedTiles === totalTiles to declutter the map
          when the rail itself takes over showing results. */}
      {tileGrid && tileGrid.loadedTiles < tileGrid.totalTiles && (
        <div className="pointer-events-none absolute bottom-7 left-3 rounded-md border border-[var(--color-line)] bg-white/95 px-3 py-2 text-[11px] shadow-sm">
          <div className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
            Tiled fetch
          </div>
          <div className="mt-0.5 font-[var(--font-mono)] text-[var(--color-ink)]">
            Loading {tileGrid.loadedTiles + 1} of {tileGrid.totalTiles} tiles
          </div>
          <div className="mt-1 h-1 w-32 overflow-hidden rounded-full bg-[var(--color-line)]">
            <div
              className="h-full bg-[var(--color-accent)] transition-[width] duration-300"
              style={{
                width: `${Math.round((tileGrid.loadedTiles / Math.max(1, tileGrid.totalTiles)) * 100)}%`,
              }}
            />
          </div>
          <div className="mt-0.5 text-[9px] text-[var(--color-ink-faint)]">
            {Math.round((tileGrid.loadedTiles / Math.max(1, tileGrid.totalTiles)) * 100)}% ·
            {" "}{tileGrid.rows}×{tileGrid.cols} grid
          </div>
        </div>
      )}
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
});
