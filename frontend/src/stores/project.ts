import { create } from "zustand";
import { api } from "@/lib/api";
import { defaultFeatureStyle } from "@/lib/defaults";
import { hexRgbToRgba, opacityToAlpha } from "@/lib/kmlColor";
import { DEFAULT_THEME_ID, colorAt, themeById, type Theme } from "@/lib/palettes";
import type {
  BrowseBakeRequest,
  BrowseBakeResponse,
  FeatureStyle,
  PlacemarkPreview,
  ProjectDetail,
  ProjectSummary,
  SourceFileDetail,
} from "@/lib/types";

/** Selection model — exactly one of these is active. */
export type Selection =
  | { kind: "none" }
  | { kind: "source"; sourceFileId: number }
  | { kind: "category"; sourceFileId: number; categoryValue: string }
  | { kind: "placemark"; sourceFileId: number; placemarkIndex: number };

interface State {
  // Project list (for the project picker landing page).
  projects: ProjectSummary[];
  loadingProjects: boolean;

  // Active project.
  currentProjectId: number | null;
  currentProject: ProjectDetail | null;

  // Per-source-file detail cache.
  sourceFiles: Record<number, SourceFileDetail>;

  selection: Selection;

  /** Layer visibility — session-only, not persisted. Investigators toggle
   * these to focus on a subset; closing the project resets everything. */
  hiddenCategories: Set<string>;
  hiddenSourceFiles: Set<number>;

  /** Active theme id used for auto-assigning colours to new categories. */
  themeId: string;

  // Async status flags shared across components.
  busy: boolean;
  error: string | null;

  // ── Phase B4 (browse mode) ──
  /** Which top-level destination the app is showing. The picker is implicit
   * (rendered whenever ``currentProjectId == null && mode === "project"``);
   * ``"browse"`` parks the project (if any) and routes to BrowseMode. */
  mode: "project" | "browse";

  // ── Phase B1 (workflow stepper) ──
  /** Which of the four guided steps is currently surfaced. Always one of the
   * four — the workspace never renders without a step. */
  workflowStep: "compose" | "style" | "review" | "export";
}

interface Actions {
  refreshProjects: () => Promise<void>;
  createProject: (name: string) => Promise<number>;
  openProject: (id: number) => Promise<void>;
  closeProject: () => void;
  renameProject: (name: string) => Promise<void>;
  deleteCurrentProject: () => Promise<void>;

  importKml: (file: File) => Promise<void>;
  refreshSourceFile: (sourceFileId: number) => Promise<void>;
  deleteSourceFile: (sourceFileId: number) => Promise<void>;

  setSelection: (s: Selection) => void;

  /** Get the style for a category, falling back to a fresh default. */
  styleForCategory: (categoryValue: string) => FeatureStyle;
  saveCategoryStyle: (categoryValue: string, style: FeatureStyle) => Promise<void>;

  saveAnnotations: (
    sourceFileId: number,
    index: number,
    fields: Record<string, string>,
  ) => Promise<void>;
  saveOverride: (
    sourceFileId: number,
    index: number,
    style: FeatureStyle | null,
  ) => Promise<void>;

  toggleCategoryVisible: (value: string) => void;
  toggleSourceFileVisible: (id: number) => void;
  setAllVisible: (visible: boolean) => void;

  setTheme: (themeId: string) => void;
  applyTheme: (themeId: string) => Promise<void>;

  setError: (e: string | null) => void;

  // ── Phase B4 (browse mode) ──
  /** Switch destinations. Doesn't close the project — that's the point of the
   * mode flag; ``"browse"`` parks the workflow so the back-arrow can restore
   * it in O(1). */
  setMode: (mode: "project" | "browse") => void;
  /** Bake handoff from BrowseMode. If ``body.project_id`` is null the backend
   * mints a fresh project; we then auto-open it and flip back to project mode
   * so the investigator lands on the new layer. */
  bakeFromBrowse: (body: BrowseBakeRequest) => Promise<BrowseBakeResponse>;

  // ── Phase B1 (workflow stepper) ──
  /** Move the workspace between Compose / Style / Review / Export. Investigators
   * can jump freely; we don't gate on completeness. */
  setWorkflowStep: (step: "compose" | "style" | "review" | "export") => void;
  /** Compose-step bake. Runs the user's Overpass QL against overpass-api.de
   * server-side and ingests the result as a new SourceFile in the active
   * project (mirroring the ``importKml`` flow byte-for-byte). Returns the new
   * source-file id so the caller can land selection on it. */
  runOverpassQuery: (body: {
    name: string;
    query: string;
    bbox: [number, number, number, number] | null;
    regionLabel?: string | null;
  }) => Promise<number>;
}

type Store = State & Actions;

/** Walk source files (in stable id order) and return the distinct category
 * values they expose, in the order they're first encountered. Same input →
 * same output, so the colour assigned to a category is deterministic across
 * reloads. */
function orderedCategoryValues(
  proj: ProjectDetail,
  sourceFiles: Record<number, SourceFileDetail>,
): string[] {
  const seen: string[] = [];
  const sortedSources = [...proj.source_files].sort((a, b) => a.id - b.id);
  for (const sf of sortedSources) {
    const detail = sourceFiles[sf.id];
    if (!detail) continue;
    const cats = Object.keys(detail.category_counts).sort();
    for (const value of cats) {
      if (!seen.includes(value)) seen.push(value);
    }
  }
  return seen;
}

function styleFromThemeColor(theme: Theme, hex: string): FeatureStyle {
  const base = defaultFeatureStyle();
  return {
    ...base,
    polygon: {
      ...base.polygon,
      fill_color: hexRgbToRgba(hex, opacityToAlpha(theme.polyAlpha)),
      outline_color: hexRgbToRgba(hex, 255),
      outline_width: 1.5,
    },
    icon: {
      ...base.icon,
      // Tint icons with the theme colour so points read as the same hue.
      color: hexRgbToRgba(hex, 255),
    },
  };
}

export const useProjectStore = create<Store>((set, get) => ({
  projects: [],
  loadingProjects: false,
  currentProjectId: null,
  currentProject: null,
  sourceFiles: {},
  selection: { kind: "none" },
  hiddenCategories: new Set(),
  hiddenSourceFiles: new Set(),
  themeId: DEFAULT_THEME_ID,
  busy: false,
  error: null,
  mode: "project",
  workflowStep: "compose",

  setError: (error) => set({ error }),

  async refreshProjects() {
    set({ loadingProjects: true });
    try {
      const projects = await api.listProjects();
      set({ projects });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ loadingProjects: false });
    }
  },

  async createProject(name) {
    const proj = await api.createProject(name);
    set((s) => ({ projects: [proj as unknown as ProjectSummary, ...s.projects] }));
    return proj.id;
  },

  async openProject(id) {
    set({
      busy: true,
      error: null,
      currentProjectId: id,
      hiddenCategories: new Set(),
      hiddenSourceFiles: new Set(),
    });
    try {
      const proj = await api.getProject(id);
      set({ currentProject: proj, selection: { kind: "none" }, sourceFiles: {} });
      const details = await Promise.all(
        proj.source_files.map((sf) => api.getSourceFile(id, sf.id)),
      );
      const byId: Record<number, SourceFileDetail> = {};
      for (const d of details) byId[d.id] = d;
      set({ sourceFiles: byId });
      await ensureCategoryColors();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  },

  closeProject() {
    set({
      currentProjectId: null,
      currentProject: null,
      sourceFiles: {},
      selection: { kind: "none" },
      hiddenCategories: new Set(),
      hiddenSourceFiles: new Set(),
    });
  },

  async renameProject(name) {
    const pid = get().currentProjectId;
    if (pid == null) return;
    const proj = await api.updateProject(pid, { name });
    set({ currentProject: proj });
    set((s) => ({ projects: s.projects.map((p) => (p.id === pid ? { ...p, name } : p)) }));
  },

  async deleteCurrentProject() {
    const pid = get().currentProjectId;
    if (pid == null) return;
    await api.deleteProject(pid);
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== pid),
      currentProjectId: null,
      currentProject: null,
      sourceFiles: {},
      selection: { kind: "none" },
      hiddenCategories: new Set(),
      hiddenSourceFiles: new Set(),
    }));
  },

  async importKml(file) {
    const pid = get().currentProjectId;
    if (pid == null) return;
    set({ busy: true, error: null });
    try {
      const summary = await api.uploadKml(pid, file);
      const detail = await api.getSourceFile(pid, summary.id);
      set((s) => ({ sourceFiles: { ...s.sourceFiles, [summary.id]: detail } }));
      const proj = await api.getProject(pid);
      set({ currentProject: proj });
      await ensureCategoryColors();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  },

  async refreshSourceFile(sourceFileId) {
    const pid = get().currentProjectId;
    if (pid == null) return;
    const detail = await api.getSourceFile(pid, sourceFileId);
    set((s) => ({ sourceFiles: { ...s.sourceFiles, [sourceFileId]: detail } }));
  },

  async deleteSourceFile(sourceFileId) {
    const pid = get().currentProjectId;
    if (pid == null) return;
    await api.deleteSourceFile(pid, sourceFileId);
    set((s) => {
      const sf = { ...s.sourceFiles };
      delete sf[sourceFileId];
      const hidden = new Set(s.hiddenSourceFiles);
      hidden.delete(sourceFileId);
      return { sourceFiles: sf, hiddenSourceFiles: hidden };
    });
    const proj = await api.getProject(pid);
    set({ currentProject: proj, selection: { kind: "none" } });
  },

  setSelection(selection) {
    set({ selection });
  },

  styleForCategory(categoryValue) {
    const existing = get().currentProject?.category_styles?.[categoryValue];
    return existing ?? defaultFeatureStyle();
  },

  async saveCategoryStyle(categoryValue, style) {
    const pid = get().currentProjectId;
    if (pid == null) return;
    const proj = await api.setCategoryStyle(pid, categoryValue, style);
    set({ currentProject: proj });
  },

  async saveAnnotations(sourceFileId, index, fields) {
    const pid = get().currentProjectId;
    if (pid == null) return;
    await api.saveAnnotations(pid, sourceFileId, index, fields);
    set((s) => {
      const sf = s.sourceFiles[sourceFileId];
      if (!sf) return {};
      const placemarks: PlacemarkPreview[] = sf.placemarks.map((p) =>
        p.index === index ? { ...p, annotations: { ...fields } } : p,
      );
      return { sourceFiles: { ...s.sourceFiles, [sourceFileId]: { ...sf, placemarks } } };
    });
  },

  async saveOverride(sourceFileId, index, style) {
    const pid = get().currentProjectId;
    if (pid == null) return;
    await api.saveOverride(pid, sourceFileId, index, style);
    set((s) => {
      const sf = s.sourceFiles[sourceFileId];
      if (!sf) return {};
      const placemarks = sf.placemarks.map((p) =>
        p.index === index ? { ...p, has_override: style !== null } : p,
      );
      return { sourceFiles: { ...s.sourceFiles, [sourceFileId]: { ...sf, placemarks } } };
    });
  },

  toggleCategoryVisible(value) {
    set((s) => {
      const next = new Set(s.hiddenCategories);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { hiddenCategories: next };
    });
  },

  toggleSourceFileVisible(id) {
    set((s) => {
      const next = new Set(s.hiddenSourceFiles);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { hiddenSourceFiles: next };
    });
  },

  setAllVisible(visible) {
    set({
      hiddenCategories: visible ? new Set() : new Set(get().currentProject ? Object.keys(allCategoryCounts(get().currentProject!, get().sourceFiles)) : []),
      hiddenSourceFiles: visible ? new Set() : new Set(get().currentProject?.source_files.map((sf) => sf.id) ?? []),
    });
  },

  setTheme(themeId) {
    set({ themeId });
  },

  async applyTheme(themeId) {
    const pid = get().currentProjectId;
    const proj = get().currentProject;
    if (pid == null || !proj) return;
    const theme = themeById(themeId);
    const ordered = orderedCategoryValues(proj, get().sourceFiles);
    set({ themeId, busy: true });
    try {
      // Re-colour each category with the theme palette. Fire in parallel; the
      // last successful response wins for `currentProject`.
      let latest = proj;
      const responses = await Promise.all(
        ordered.map((value, idx) => {
          const style = styleFromThemeColor(theme, colorAt(theme, idx));
          return api.setCategoryStyle(pid, value, style);
        }),
      );
      if (responses.length > 0) latest = responses[responses.length - 1];
      set({ currentProject: latest });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  },

  // ── Phase B4 (browse mode) ──
  setMode(mode) {
    set({ mode });
  },

  async bakeFromBrowse(body) {
    set({ busy: true, error: null });
    try {
      const result = await api.browse.bake(body);
      // Refresh the project list — a fresh project may have been minted, and
      // the layer count on an existing project just changed.
      try {
        const projects = await api.listProjects();
        set({ projects });
      } catch {
        /* non-fatal; the bake itself succeeded */
      }
      // Auto-open the destination project so the investigator lands on the
      // baked layer. ``openProject`` handles selection + source-file detail
      // fetching; we then flip back to project mode so the workspace renders.
      await get().openProject(result.project_id);
      set({ mode: "project" });
      return result;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ busy: false });
    }
  },

  // ── Phase B1 (workflow stepper) ──
  setWorkflowStep(step) {
    set({ workflowStep: step });
  },

  async runOverpassQuery(body) {
    const pid = get().currentProjectId;
    if (pid == null) {
      throw new Error("No active project to attach the layer to.");
    }
    set({ busy: true, error: null });
    try {
      const summary = await api.runOverpassQuery(pid, {
        name: body.name,
        query: body.query,
        bbox: body.bbox,
        region_label: body.regionLabel ?? null,
      });
      const detail = await api.getSourceFile(pid, summary.id);
      set((s) => ({ sourceFiles: { ...s.sourceFiles, [summary.id]: detail } }));
      const proj = await api.getProject(pid);
      set({ currentProject: proj });
      await ensureCategoryColors();
      return summary.id;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ busy: false });
    }
  },
}));

/** For categories that don't yet have a saved style, assign them the next free
 * colour from the active theme and PUT it. Called after openProject and
 * importKml so the investigator never lands on an all-grey map.
 *
 * Detached helper (closure over the store) so both the open and import flows
 * can call it cheaply. Reads/writes via get/set directly. */
async function ensureCategoryColors(): Promise<void> {
  const state = useProjectStore.getState();
  const proj = state.currentProject;
  const pid = state.currentProjectId;
  if (!proj || pid == null) return;
  const theme = themeById(state.themeId);
  const ordered = orderedCategoryValues(proj, state.sourceFiles);
  const missing = ordered.filter((v) => !proj.category_styles[v]);
  if (missing.length === 0) return;

  // Assign colours by the value's position in the deterministic ordering, so
  // adding a new category later doesn't reshuffle previously-assigned hues.
  const tasks = missing.map((value) => {
    const idx = ordered.indexOf(value);
    const style = styleFromThemeColor(theme, colorAt(theme, idx));
    return api.setCategoryStyle(pid, value, style);
  });
  try {
    const results = await Promise.all(tasks);
    // Use the last response as the freshest project snapshot.
    if (results.length > 0) {
      useProjectStore.setState({ currentProject: results[results.length - 1] });
    }
  } catch (e) {
    useProjectStore.setState({ error: String(e) });
  }
}

function allCategoryCounts(
  proj: ProjectDetail,
  sourceFiles: Record<number, SourceFileDetail>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sf of proj.source_files) {
    const d = sourceFiles[sf.id];
    if (!d) continue;
    for (const [k, v] of Object.entries(d.category_counts)) {
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}
