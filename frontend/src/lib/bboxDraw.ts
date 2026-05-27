/**
 * bboxDraw — shared "drag to draw a rectangle" interaction on a MapLibre map.
 *
 * Both the Compose-step BboxPicker and the Browse-mode command strip need
 * the same affordance: while it's active, the user can drag on the map
 * canvas to define a bounding box; on release we commit `[W, S, E, N]`.
 *
 * Usage:
 *   const handle = startBboxDraw(map, {
 *     onCommit: (bbox) => { setBbox(bbox); handle.dispose(); },
 *     onCancel: () => { handle.dispose(); },
 *   });
 *   // later: handle.dispose() to tear down without committing.
 *
 * Lifecycle:
 *   - Disables map pan/zoom-on-drag for the duration of the draw.
 *   - Renders a translucent rectangle + dashed outline using two private
 *     GeoJSON sources (`bbox-draw-fill` / `bbox-draw-outline`).
 *   - Listens for Escape on `window` to cancel.
 *   - `dispose()` is idempotent and restores the map handlers cleanly.
 *
 * The draw layers are added on top of whatever is currently in the style.
 * If they already exist (e.g. from a previous draw session that didn't
 * clean up perfectly), they're removed first.
 */
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";

export type Bbox = [number, number, number, number];

const SOURCE_FILL = "bbox-draw-fill";
const SOURCE_OUTLINE = "bbox-draw-outline";
const LAYER_FILL = "bbox-draw-fill";
const LAYER_OUTLINE = "bbox-draw-outline";

// Separate set of sources/layers for a *persistent* bbox overlay. Drawing
// uses transient layers (cleared on dispose); the overlay survives across
// arms so a committed bbox stays visible on the workspace map.
const OVERLAY_SOURCE_FILL = "bbox-overlay-fill";
const OVERLAY_SOURCE_OUTLINE = "bbox-overlay-outline";
const OVERLAY_LAYER_FILL = "bbox-overlay-fill";
const OVERLAY_LAYER_OUTLINE = "bbox-overlay-outline";

export interface BboxDrawHandle {
  dispose: () => void;
}

export interface BboxDrawOptions {
  /** Called with [W, S, E, N] on mouseup, only if the rectangle has
   *  meaningful extent (≥ ~1px on both axes — guards against accidental
   *  clicks). */
  onCommit: (bbox: Bbox) => void;
  /** Called when the user hits Escape mid-draw, or when dispose runs
   *  before any commit. Optional. */
  onCancel?: () => void;
}

export function startBboxDraw(
  map: MapLibreMap,
  { onCommit, onCancel }: BboxDrawOptions,
): BboxDrawHandle {
  const canvas = map.getCanvas();
  const prevCursor = canvas.style.cursor;
  canvas.style.cursor = "crosshair";

  // Snapshot the interaction state we want to disable so we can put it
  // back exactly as it was. We deliberately leave scroll-zoom on — the
  // operator may want to zoom in for a precise corner.
  const dragWasEnabled = map.dragPan.isEnabled();
  const boxZoomWasEnabled = map.boxZoom.isEnabled();
  map.dragPan.disable();
  map.boxZoom.disable();

  ensureLayers(map);
  clearShape(map);

  let anchor: [number, number] | null = null;
  let lastBox: Bbox | null = null;
  let disposed = false;

  function onMouseDown(e: MapMouseEvent) {
    if (disposed) return;
    if ((e.originalEvent as MouseEvent).button !== 0) return;
    anchor = [e.lngLat.lng, e.lngLat.lat];
    lastBox = bboxFrom(anchor, anchor);
    paintShape(map, lastBox);
    e.preventDefault();
  }

  function onMouseMove(e: MapMouseEvent) {
    if (disposed || !anchor) return;
    const here: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    lastBox = bboxFrom(anchor, here);
    paintShape(map, lastBox);
  }

  function onMouseUp(e: MapMouseEvent) {
    if (disposed || !anchor) return;
    const here: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    const bbox = bboxFrom(anchor, here);
    anchor = null;
    lastBox = bbox;
    paintShape(map, bbox);
    // Treat near-zero-area rectangles as accidental clicks.
    const dx = Math.abs(bbox[2] - bbox[0]);
    const dy = Math.abs(bbox[3] - bbox[1]);
    if (dx < 1e-6 || dy < 1e-6) {
      onCancel?.();
      dispose();
      return;
    }
    onCommit(bbox);
    dispose();
  }

  function onKey(ev: KeyboardEvent) {
    if (ev.key === "Escape") {
      onCancel?.();
      dispose();
    }
  }

  map.on("mousedown", onMouseDown);
  map.on("mousemove", onMouseMove);
  map.on("mouseup", onMouseUp);
  window.addEventListener("keydown", onKey, true);

  function dispose() {
    if (disposed) return;
    disposed = true;
    canvas.style.cursor = prevCursor;
    if (dragWasEnabled) map.dragPan.enable();
    if (boxZoomWasEnabled) map.boxZoom.enable();
    try {
      map.off("mousedown", onMouseDown);
      map.off("mousemove", onMouseMove);
      map.off("mouseup", onMouseUp);
    } catch {
      /* ignore */
    }
    window.removeEventListener("keydown", onKey, true);
    clearShape(map);
  }

  // Reference lastBox in dispose so TS doesn't whine about unused locals.
  void lastBox;

  return { dispose };
}

function bboxFrom(a: [number, number], b: [number, number]): Bbox {
  const w = Math.min(a[0], b[0]);
  const e = Math.max(a[0], b[0]);
  const s = Math.min(a[1], b[1]);
  const n = Math.max(a[1], b[1]);
  return [w, s, e, n];
}

function ensureLayers(map: MapLibreMap) {
  const ensureSource = (id: string) => {
    if (!map.getSource(id)) {
      map.addSource(id, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
  };
  ensureSource(SOURCE_FILL);
  ensureSource(SOURCE_OUTLINE);

  if (!map.getLayer(LAYER_FILL)) {
    map.addLayer({
      id: LAYER_FILL,
      type: "fill",
      source: SOURCE_FILL,
      paint: {
        "fill-color": "#2a5d6b",
        "fill-opacity": 0.18,
      },
    });
  }
  if (!map.getLayer(LAYER_OUTLINE)) {
    map.addLayer({
      id: LAYER_OUTLINE,
      type: "line",
      source: SOURCE_OUTLINE,
      paint: {
        "line-color": "#2a5d6b",
        "line-width": 2,
        "line-dasharray": [3, 2],
      },
    });
  }
}

function paintShape(map: MapLibreMap, bbox: Bbox) {
  const [w, s, e, n] = bbox;
  const ring: [number, number][] = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
  const fillSrc = map.getSource(SOURCE_FILL) as
    | { setData: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  const outlineSrc = map.getSource(SOURCE_OUTLINE) as
    | { setData: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  fillSrc?.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  });
  outlineSrc?.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: ring },
      },
    ],
  });
}

function clearShape(map: MapLibreMap) {
  const fillSrc = map.getSource(SOURCE_FILL) as
    | { setData: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  const outlineSrc = map.getSource(SOURCE_OUTLINE) as
    | { setData: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  fillSrc?.setData({ type: "FeatureCollection", features: [] });
  outlineSrc?.setData({ type: "FeatureCollection", features: [] });
}

function ensureOverlayLayers(map: MapLibreMap) {
  if (!map.getSource(OVERLAY_SOURCE_FILL)) {
    map.addSource(OVERLAY_SOURCE_FILL, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getSource(OVERLAY_SOURCE_OUTLINE)) {
    map.addSource(OVERLAY_SOURCE_OUTLINE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer(OVERLAY_LAYER_FILL)) {
    map.addLayer({
      id: OVERLAY_LAYER_FILL,
      type: "fill",
      source: OVERLAY_SOURCE_FILL,
      paint: { "fill-color": "#2a5d6b", "fill-opacity": 0.12 },
    });
  }
  if (!map.getLayer(OVERLAY_LAYER_OUTLINE)) {
    map.addLayer({
      id: OVERLAY_LAYER_OUTLINE,
      type: "line",
      source: OVERLAY_SOURCE_OUTLINE,
      paint: {
        "line-color": "#2a5d6b",
        "line-width": 2,
        "line-dasharray": [3, 2],
      },
    });
  }
}

/** Paint a persistent bbox rectangle. Idempotent — calling with the same
 *  bbox does nothing visually new but is safe to invoke from a React
 *  effect on every render. */
export function paintBboxOverlay(map: MapLibreMap, bbox: Bbox) {
  ensureOverlayLayers(map);
  const [w, s, e, n] = bbox;
  const ring: [number, number][] = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
  const fill = map.getSource(OVERLAY_SOURCE_FILL) as
    | { setData: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  const outline = map.getSource(OVERLAY_SOURCE_OUTLINE) as
    | { setData: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  fill?.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  });
  outline?.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: ring },
      },
    ],
  });
}

/** Clear the persistent overlay. No-op if the layers don't exist yet. */
export function clearBboxOverlay(map: MapLibreMap) {
  const fill = map.getSource(OVERLAY_SOURCE_FILL) as
    | { setData: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  const outline = map.getSource(OVERLAY_SOURCE_OUTLINE) as
    | { setData: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  fill?.setData({ type: "FeatureCollection", features: [] });
  outline?.setData({ type: "FeatureCollection", features: [] });
}

/** Fly the map to a bbox without animating sharply — used after the
 *  user picks a region via search/coords so they see what they chose. */
export function fitBboxOverlay(map: MapLibreMap, bbox: Bbox) {
  try {
    map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      { padding: 60, animate: true, maxZoom: 12 },
    );
  } catch {
    /* ignore — invalid bbox */
  }
}
