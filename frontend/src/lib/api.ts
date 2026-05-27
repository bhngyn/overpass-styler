import type {
  FeatureStyle,
  IconCatalogue,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${resp.status} ${resp.statusText}: ${body}`);
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
};
