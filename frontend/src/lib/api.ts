import type {
  BrowseBakeRequest,
  BrowseBakeResponse,
  BrowseBbox,
  BrowseFeatureDetail,
  BrowseInventoryResponse,
  BrowseItemsResponse,
  BrowsePreflightResponse,
  BrowseTiledInventoryResponse,
  FeatureStyle,
  IconCatalogue,
  OverpassQueryPreflightResponse,
  PresetSummary,
  ProjectDetail,
  ProjectSummary,
  SourceFileDetail,
  SourceFileSummary,
} from "./types";
import type {
  CuratedResponse,
  MergedTagResponse,
  SearchResponse,
  TaginfoKeysResponse,
  TaginfoValuesResponse,
} from "./tagLibrary.types";

const BASE = "/api";

/** Thrown for non-2xx responses with the FastAPI ``detail`` extracted into
 *  ``.detail`` so callers can surface an actionable message instead of the
 *  full raw body. ``isAbort`` distinguishes user-initiated cancellation
 *  from a real failure so UI code doesn't show a "request failed" toast
 *  when the operator just clicked Cancel. */
export class ApiError extends Error {
  status: number;
  detail: string;
  isAbort: boolean;
  constructor(status: number, detail: string, isAbort = false) {
    super(detail || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.isAbort = isAbort;
  }
}

function extractDetail(body: string): string {
  // FastAPI default error shape is ``{"detail": "..."}``; surface that, but
  // also tolerate plain-text bodies so a misconfigured proxy doesn't drop
  // the whole error.
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // not JSON, fall through
  }
  return body.trim();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE}${path}`, {
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(0, "request cancelled", true);
    }
    throw new ApiError(0, err instanceof Error ? err.message : String(err));
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new ApiError(resp.status, extractDetail(body) || resp.statusText);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<ProjectSummary[]>("/projects"),
  createProject: (name: string) =>
    request<ProjectDetail>("/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  getProject: (id: number) => request<ProjectDetail>(`/projects/${id}`),
  updateProject: (id: number, patch: Partial<{ name: string; category_key: string }>) =>
    request<ProjectDetail>(`/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteProject: (id: number) =>
    request<void>(`/projects/${id}`, { method: "DELETE" }),

  uploadKml: async (projectId: number, file: File): Promise<SourceFileSummary> => {
    const form = new FormData();
    form.append("file", file);
    const resp = await fetch(`${BASE}/projects/${projectId}/source-files`, {
      method: "POST",
      body: form,
    });
    if (!resp.ok) {
      throw new Error(`upload failed: ${resp.status} ${await resp.text()}`);
    }
    return resp.json();
  },
  getSourceFile: (projectId: number, sourceFileId: number) =>
    request<SourceFileDetail>(`/projects/${projectId}/source-files/${sourceFileId}`),
  deleteSourceFile: (projectId: number, sourceFileId: number) =>
    request<void>(`/projects/${projectId}/source-files/${sourceFileId}`, {
      method: "DELETE",
    }),

  setCategoryStyle: (projectId: number, value: string, style: FeatureStyle) =>
    request<ProjectDetail>(`/projects/${projectId}/styles/${encodeURIComponent(value)}`, {
      method: "PUT",
      body: JSON.stringify({ style }),
    }),
  deleteCategoryStyle: (projectId: number, value: string) =>
    request<ProjectDetail>(`/projects/${projectId}/styles/${encodeURIComponent(value)}`, {
      method: "DELETE",
    }),

  saveAnnotations: (
    projectId: number,
    sourceFileId: number,
    index: number,
    fields: Record<string, string>,
  ) =>
    request<Record<string, string>>(
      `/projects/${projectId}/source-files/${sourceFileId}/placemarks/${index}/annotations`,
      { method: "PUT", body: JSON.stringify({ fields }) },
    ),
  saveOverride: (
    projectId: number,
    sourceFileId: number,
    index: number,
    style: FeatureStyle | null,
  ) =>
    request<void>(
      `/projects/${projectId}/source-files/${sourceFileId}/placemarks/${index}/override`,
      { method: "PUT", body: JSON.stringify({ style }) },
    ),

  refetchOsm: (projectId: number, sourceFileId: number, index: number) =>
    request<{ tags: Record<string, string>; fetched_at: string }>(
      `/projects/${projectId}/source-files/${sourceFileId}/placemarks/${index}/refetch-osm`,
      { method: "POST" },
    ),
  reverseGeocode: (projectId: number, sourceFileId: number, index: number) =>
    request<{ address: Record<string, string>; display_name: string; fetched_at: string }>(
      `/projects/${projectId}/source-files/${sourceFileId}/placemarks/${index}/reverse-geocode`,
      { method: "POST" },
    ),

  listPresets: () => request<PresetSummary[]>("/presets"),
  createPreset: (name: string, style: FeatureStyle) =>
    request<PresetSummary>("/presets", {
      method: "POST",
      body: JSON.stringify({ name, style }),
    }),
  deletePreset: (id: number) =>
    request<void>(`/presets/${id}`, { method: "DELETE" }),

  exportUrl: (projectId: number) => `${BASE}/projects/${projectId}/export`,

  icons: () => request<IconCatalogue>("/icons"),

  // ── Phase B1 (overpass queries) ─────────────────────────────────────────
  // Compose-step bake: takes user-authored Overpass QL, the runner substitutes
  // {{bbox}} server-side and ingests the result as a new SourceFile byte-
  // identical to one created from an uploaded KML. Pass ``signal`` to wire
  // up an AbortController so the operator can cancel a long bake.
  runOverpassQuery: (
    projectId: number,
    body: {
      name: string;
      query: string;
      bbox: [number, number, number, number] | null;
      region_label?: string | null;
    },
    signal?: AbortSignal,
  ) =>
    request<SourceFileSummary>(`/projects/${projectId}/overpass-queries`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),

  // ── Phase B3 (tag library) ──────────────────────────────────────────────
  // Drawer-facing endpoints. ``curated`` is local-only; the other four hit
  // Taginfo behind a 7-day on-disk cache (see backend/app/enrichment/taginfo.py).
  tagLibrary: {
    curated: () => request<CuratedResponse>("/tag-library/curated"),
    keys: () => request<TaginfoKeysResponse>("/tag-library/keys"),
    values: (key: string) =>
      request<TaginfoValuesResponse>(
        `/tag-library/values?key=${encodeURIComponent(key)}`,
      ),
    tag: (key: string, value: string) =>
      request<MergedTagResponse>(
        `/tag-library/tag?key=${encodeURIComponent(key)}&value=${encodeURIComponent(value)}`,
      ),
    search: (q: string) =>
      request<SearchResponse>(`/tag-library/search?q=${encodeURIComponent(q)}`),
  },

  // ── Phase B4 (browse mode) ──────────────────────────────────────────────
  // Field-Atlas endpoints. ``inventory`` is the heavy hitter — a domain
  // partition of every OSM feature inside the bbox; ``items`` is the
  // drill-in list; ``item`` is full per-feature detail; ``bake`` is the
  // handoff back into the project workflow.
  browse: {
    inventory: (bbox: BrowseBbox, signal?: AbortSignal) =>
      request<BrowseInventoryResponse>("/browse/inventory", {
        method: "POST",
        body: JSON.stringify({ bbox }),
        signal,
      }),
    items: (bbox: BrowseBbox, key: string, value: string, offset = 0, limit = 200) => {
      const q = new URLSearchParams({
        bbox: bbox.join(","),
        key,
        value,
        offset: String(offset),
        limit: String(limit),
      });
      return request<BrowseItemsResponse>(`/browse/items?${q.toString()}`);
    },
    item: (osmId: string) =>
      request<BrowseFeatureDetail>(`/browse/item?osm_id=${encodeURIComponent(osmId)}`),
    bake: (body: BrowseBakeRequest, signal?: AbortSignal) =>
      request<BrowseBakeResponse>("/browse/bake", {
        method: "POST",
        body: JSON.stringify(body),
        signal,
      }),

    // ── Phase L2 (large-query support) ──
    // Preflight runs a cheap "count + area" check; the result steers the
    // UI between single-shot, adaptive-tiled, or refuse-with-reason paths.
    preflight: (bbox: BrowseBbox, signal?: AbortSignal) =>
      request<BrowsePreflightResponse>("/browse/preflight", {
        method: "POST",
        body: JSON.stringify({ bbox }),
        signal,
      }),
    // Tiled inventory aggregates results across an L1-provided tile grid.
    // The response carries the same shape as `/inventory` plus a partial
    // flag + per-tile failure list so the UI can degrade gracefully.
    inventoryTiled: (tiles: BrowseBbox[], signal?: AbortSignal) =>
      request<BrowseTiledInventoryResponse>("/browse/inventory-tiled", {
        method: "POST",
        body: JSON.stringify({ tiles }),
        signal,
      }),
  },

  // ── Phase L2 (large-query support) ──
  // Compose-step preflight — same idea as browse.preflight, but for an
  // arbitrary Overpass QL string. Lets the UI display feature counts and
  // estimated KML size before the operator commits to a full bake.
  runOverpassQueryPreflight: (
    projectId: number,
    body: { query: string; bbox: [number, number, number, number] | null },
    signal?: AbortSignal,
  ) =>
    request<OverpassQueryPreflightResponse>(
      `/projects/${projectId}/overpass-queries/preflight`,
      { method: "POST", body: JSON.stringify(body), signal },
    ),
};
