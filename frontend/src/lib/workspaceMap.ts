/**
 * workspaceMap — module-level registry for the ProjectWorkspace's MapPreview.
 *
 * MapPreview is the only MapLibre instance mounted by ProjectWorkspace, so
 * it's effectively a singleton during a workspace session. Rather than
 * threading a ref through context providers across half the component
 * tree, MapPreview registers itself here on mount, and the BboxPicker
 * (which lives in QueryEditor's right-rail form) reads the same registry
 * to drive draw + overlay onto the workspace map.
 *
 * Why not React Context? The map ref is needed by a deeply nested
 * descendant (BboxPicker → QueryEditor → ComposeStep → ProjectWorkspace),
 * and the producer (MapPreview) is a *sibling* of ComposeStep, not an
 * ancestor. A context provider would have to live above both — yet the
 * map instance itself only exists once MapPreview has mounted. A simple
 * subscribable holder is enough and avoids the ceremony.
 */
import type { Map as MapLibreMap } from "maplibre-gl";

type Listener = (map: MapLibreMap | null) => void;
type DrawingListener = (drawing: boolean) => void;

let current: MapLibreMap | null = null;
let drawing = false;
const listeners = new Set<Listener>();
const drawingListeners = new Set<DrawingListener>();

/** Called by MapPreview's mount effect once the map and its core layers
 *  are ready. Pass `null` from the unmount cleanup. */
export function setWorkspaceMap(map: MapLibreMap | null) {
  current = map;
  for (const fn of listeners) fn(map);
}

/** Read the current map. Returns null if MapPreview hasn't mounted yet
 *  (or has already unmounted). */
export function getWorkspaceMap(): MapLibreMap | null {
  return current;
}

/** Subscribe to changes — used by hooks that need to re-arm draw when
 *  the workspace map remounts (e.g. step transitions that drop Compose). */
export function subscribeWorkspaceMap(fn: Listener): () => void {
  listeners.add(fn);
  // Fire immediately with the current value so subscribers don't need a
  // separate one-shot read.
  fn(current);
  return () => listeners.delete(fn);
}

/** Flip the "drawing on the workspace map" signal. The BboxPicker arms +
 *  un-arms via this; MapPreview reads it to render a coaching pill. */
export function setWorkspaceDrawing(active: boolean) {
  if (drawing === active) return;
  drawing = active;
  for (const fn of drawingListeners) fn(active);
}

export function subscribeWorkspaceDrawing(fn: DrawingListener): () => void {
  drawingListeners.add(fn);
  fn(drawing);
  return () => drawingListeners.delete(fn);
}
