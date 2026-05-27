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
} as const;

const LAYER_IDS = {
  bboxMask: "browse-bbox-mask",
  bboxOutline: "browse-bbox-outline",
  items: "browse-items",
  itemsHighlight: "browse-items-highlight",
} as const;

export interface BrowseMapHandle {
  /** Read the current visible bounds. Returns null if the map hasn't
   * finished mounting yet. */
  getViewportBbox: () => BrowseBbox | null;
  /** Fly the map to a bbox without setting it as the "selected" bbox
   * (used by the search-to-place flow before the user commits). */
  flyToBbox: (bbox: BrowseBbox) => void;
}

interface Props {
  bbox: BrowseBbox | null;
  items: BrowseItemSummary[];
  hoveredOsmId: string | null;
  selectedOsmId: string | null;
  onFeatureClick: (osmId: string) => void;
}

export const BrowseMap = forwardRef<BrowseMapHandle, Props>(function BrowseMap(
  { bbox, items, hoveredOsmId, selectedOsmId, onFeatureClick },
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
        map.addSource(SOURCE_IDS.items, {
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
        map.addLayer({
          id: LAYER_IDS.items,
          type: "circle",
          source: SOURCE_IDS.items,
          paint: {
            // Muted ink — reconnaissance is neutral. We deliberately don't
            // tint by domain; that's what InventoryRail is for.
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

        map.on("click", LAYER_IDS.items, (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const osmId = f.properties?.osm_id as string | undefined;
          if (osmId) onClickRef.current(osmId);
        });

        map.on("mouseenter", LAYER_IDS.items, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", LAYER_IDS.items, () => {
          map.getCanvas().style.cursor = "";
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
