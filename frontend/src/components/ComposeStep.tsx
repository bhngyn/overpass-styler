/**
 * ComposeStep — top-level container for Step 1 of the workflow.
 *
 * Layout: left rail (layer stack of source files + query drafts) and right
 * rail (query editor when a draft is selected). The map is mounted as a
 * sibling by ProjectWorkspace, so we never re-init MapLibre between steps.
 *
 * Drop-in behaviour: entering Compose with no drafts auto-creates one, so
 * the investigator lands directly on the Builder surface — no "+ New
 * layer" empty-state click required.
 *
 * Query drafts live in component state, not Zustand — drafts shouldn't leak
 * across project switches.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { QueryEditor, type QueryDraft } from "@/components/QueryEditor";
import { useProjectStore } from "@/stores/project";
import { api } from "@/lib/api";
import type { GlossaryEntry } from "@/lib/tagLibrary.types";
import { SUBJECT_CATALOG } from "@/lib/subjectCatalog";

// Module-level session flag — once the investigator confirms the first
// Overpass call, we don't ask again until the page reloads.
let overpassConfirmedThisSession = false;

// Module-level glossary cache — the curated catalog doesn't change between
// projects or step visits, so we fetch it once per page-load and share the
// payload across every ComposeStep mount.
let glossaryCache: GlossaryEntry[] | null = null;
let glossaryFetchPromise: Promise<GlossaryEntry[]> | null = null;

interface Props {
  /** Plumbs the existing Tag Library drawer down to QueryEditor. The
   *  Builder uses it as the "search all OpenStreetMap tags" fallback in
   *  its subject picker; raw-mode uses it as the legacy tag-insert path. */
  onOpenTagLibrary?: () => void;
}

function newDraft(): QueryDraft {
  return {
    id: crypto.randomUUID(),
    // Wall-clock at creation so the rail sorts by add-order. UUID-based sort
    // (the previous behaviour) shuffled drafts unpredictably (D2 #14).
    createdAt: Date.now(),
    name: "",
    query: "",
    bbox: null,
    regionLabel: null,
    lastRunResult: null,
    selectedSubjectIds: [],
    customTags: [],
    editorMode: "builder",
  };
}

export function ComposeStep({ onOpenTagLibrary }: Props) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const sourceFiles = useProjectStore((s) => s.sourceFiles);
  const runOverpassQuery = useProjectStore((s) => s.runOverpassQuery);
  const importKml = useProjectStore((s) => s.importKml);
  const setSelection = useProjectStore((s) => s.setSelection);
  const setWorkflowStep = useProjectStore((s) => s.setWorkflowStep);

  const [drafts, setDrafts] = useState<Record<string, QueryDraft>>({});
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [runningDraftId, setRunningDraftId] = useState<string | null>(null);
  const [addingDraftId, setAddingDraftId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overpassConfirmed, setOverpassConfirmed] =
    useState<boolean>(overpassConfirmedThisSession);

  // Curated glossary — shared by every draft's QueryBuilder. Fetched once
  // per page load, cached in a module-level variable so navigating back
  // into Compose doesn't refetch.
  const [glossary, setGlossary] = useState<GlossaryEntry[]>(glossaryCache ?? []);
  const [glossaryLoading, setGlossaryLoading] = useState<boolean>(
    glossaryCache === null,
  );
  const [glossaryError, setGlossaryError] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (glossaryCache) return; // already populated
    let cancelled = false;
    if (!glossaryFetchPromise) {
      glossaryFetchPromise = api.tagLibrary
        .curated()
        .then((r) => {
          glossaryCache = r.entries;
          return r.entries;
        })
        .catch((e) => {
          // Rethrow so awaiting effects (and any future second mount) see
          // the failure; also clear so a refresh can retry from a future
          // mount.
          glossaryFetchPromise = null;
          throw e;
        });
    }
    glossaryFetchPromise
      .then((entries) => {
        if (cancelled) return;
        setGlossary(entries);
        setGlossaryLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setGlossaryError(String(e));
        setGlossaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const draftList = useMemo(
    () => Object.values(drafts).sort((a, b) => a.createdAt - b.createdAt),
    [drafts],
  );

  const selectedDraft = selectedDraftId ? drafts[selectedDraftId] : null;

  function createDraft() {
    const d = newDraft();
    setDrafts((s) => ({ ...s, [d.id]: d }));
    setSelectedDraftId(d.id);
  }

  // Auto-create the first draft on entry. The investigator should land on
  // the Builder surface immediately — no "Define a layer" empty state to
  // dismiss. A ref guards against React StrictMode's double-mount, which
  // would otherwise produce two empty drafts (the closed-over state in
  // the second invocation still reads drafts === {}).
  const autoCreatedRef = useRef(false);
  useEffect(() => {
    if (autoCreatedRef.current) return;
    autoCreatedRef.current = true;
    if (Object.keys(drafts).length > 0) return;
    const d = newDraft();
    setDrafts({ [d.id]: d });
    setSelectedDraftId(d.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateDraft(next: QueryDraft) {
    setDrafts((s) => ({ ...s, [next.id]: next }));
  }

  async function handleRun() {
    if (!selectedDraft) return;
    setRunningDraftId(selectedDraft.id);
    setError(null);
    try {
      // Preflight (the real work) happens inside QueryEditor via its
      // onPreflight prop. This handler stays as a no-op seam — kept so
      // the parent can hook telemetry / spinner state without rewriting
      // QueryEditor when a future direct-count endpoint lands.
    } catch (e) {
      setError(String(e));
    } finally {
      setRunningDraftId(null);
    }
  }

  async function handleAddAsLayer(signal?: AbortSignal) {
    if (!selectedDraft) return;
    setAddingDraftId(selectedDraft.id);
    setError(null);
    try {
      const sfid = await runOverpassQuery({
        // Auto-name when blank, so a non-technical investigator who doesn't
        // bother with the layer-name field never hits a silent validation
        // failure. The auto-name draws from the selected subjects + the
        // region label so it reads like something the user might have
        // typed themselves. They can rename in the Style step.
        name: selectedDraft.name.trim() || autoLayerName(selectedDraft),
        query: selectedDraft.query,
        bbox: selectedDraft.bbox,
        regionLabel: selectedDraft.regionLabel,
      }, signal);
      // Drop the draft now that it's baked.
      setDrafts((s) => {
        const next = { ...s };
        delete next[selectedDraft.id];
        return next;
      });
      setSelectedDraftId(null);
      // Land the user in Style with the new source selected.
      if (typeof sfid === "number") {
        setSelection({ kind: "source", sourceFileId: sfid });
      }
      setWorkflowStep("style");
    } catch {
      // The store already set the App-level error banner before re-throwing
      // (see runOverpassQuery in stores/project.ts). Surfacing the same
      // message inline here would double-report. The throw is sufficient
      // to skip the subsequent navigation; we just clean up the spinner.
      // D2 review #15.
    } finally {
      setAddingDraftId(null);
    }
  }

  function handleImportKml(file: File) {
    void importKml(file);
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left rail — layer stack */}
      <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-surface-sunken)]">
        <div className="border-b border-[var(--color-line)] px-4 py-3">
          <p
            className="uppercase text-[var(--color-ink-faint)]"
            style={{ fontSize: "10px", letterSpacing: "0.22em", fontWeight: 600 }}
          >
            Layers
          </p>
          <p className="mt-1 text-[11px] text-[var(--color-ink-soft)]">
            {currentProject?.source_files.length ?? 0} source file
            {(currentProject?.source_files.length ?? 0) === 1 ? "" : "s"}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
          {/* Existing source files */}
          <ul className="space-y-1.5">
            {(currentProject?.source_files ?? []).map((sf) => {
              const detail = sourceFiles[sf.id];
              const placemarkCount = detail?.placemark_count ?? sf.placemark_count;
              return (
                <li key={sf.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelection({ kind: "source", sourceFileId: sf.id });
                      setWorkflowStep("style");
                    }}
                    className="block w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-3 py-2 text-left transition-colors hover:border-[var(--color-line-strong)]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-[var(--color-ink)]" title={sf.filename}>
                        {sf.filename}
                      </span>
                      <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">
                        {placemarkCount}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <SourcePip kind={sf.filename.endsWith(".overpass.kml") ? "query" : "upload"} />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Drafts */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p
                className="uppercase text-[var(--color-ink-faint)]"
                style={{ fontSize: "9px", letterSpacing: "0.22em", fontWeight: 600 }}
              >
                Drafts
              </p>
              <span className="text-[10px] text-[var(--color-ink-faint)]">
                {draftList.length}
              </span>
            </div>
            {draftList.length === 0 && (
              <p className="text-[11px] italic text-[var(--color-ink-faint)]">
                No drafts yet — compose a query to begin.
              </p>
            )}
            <ul className="space-y-1.5">
              {draftList.map((d) => {
                const isSelected = selectedDraftId === d.id;
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedDraftId(d.id)}
                      className={[
                        "block w-full rounded-md border bg-[var(--color-surface-raised)] px-3 py-2 text-left transition-colors",
                        isSelected
                          ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]"
                          : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]",
                      ].join(" ")}
                    >
                      <span className="block truncate text-sm font-medium text-[var(--color-ink)]">
                        {d.name.trim() || "Untitled query"}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-[var(--color-ink-faint)]">
                        {d.lastRunResult
                          ? `${d.lastRunResult.totalCount.toLocaleString()} features`
                          : "Not run yet"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="space-y-2 border-t border-[var(--color-line)] px-3 py-3">
          <Button
            variant="primary"
            onClick={createDraft}
            className="w-full justify-center"
          >
            + New layer
          </Button>
          <Button
            variant="ghost"
            onClick={() => fileInput.current?.click()}
            className="w-full justify-center"
          >
            Import KML file…
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".kml,application/vnd.google-earth.kml+xml"
            className="hidden"
            multiple
            onChange={(e) => {
              const files = e.target.files;
              if (!files) return;
              for (const f of Array.from(files)) handleImportKml(f);
              e.currentTarget.value = "";
            }}
          />
          <p className="text-[10px] italic text-[var(--color-ink-faint)]">
            KML upload is the fallback for prior Overpass Turbo exports.
          </p>
        </div>
      </aside>

      {/* Right rail — query editor */}
      <section className="flex h-full flex-1 flex-col overflow-y-auto bg-[var(--color-surface)]">
        {error && (
          <div className="m-4 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-3 py-2 text-[12px] text-[var(--color-danger)]">
            {error}
          </div>
        )}
        {selectedDraft && (
          <div className="w-full px-5 py-5">
            <QueryEditor
              draft={selectedDraft}
              onChange={updateDraft}
              onRun={handleRun}
              onAddAsLayer={handleAddAsLayer}
              running={runningDraftId === selectedDraft.id}
              adding={addingDraftId === selectedDraft.id}
              onOpenTagLibrary={onOpenTagLibrary}
              overpassConfirmed={overpassConfirmed}
              onConfirmOverpass={() => {
                overpassConfirmedThisSession = true;
                setOverpassConfirmed(true);
              }}
              onPreflight={
                currentProject
                  ? (query, bbox, signal) =>
                      api.runOverpassQueryPreflight(
                        currentProject.id,
                        { query, bbox },
                        signal,
                      )
                  : undefined
              }
              glossaryEntries={glossary}
              glossaryLoading={glossaryLoading}
              glossaryError={glossaryError}
            />
          </div>
        )}
      </section>
    </div>
  );
}

/** Generate a default layer name from the draft's selected subjects + region.
 *
 *  Examples (region label "Chad"):
 *   1 subject:  "Prisons & detention — Chad"
 *   2 subjects: "Prisons & detention + Hospitals & clinics — Chad"
 *   3 subjects: "Prisons & detention + 2 more — Chad"
 *   no subjects (raw mode only): "Untitled query — Chad" or just a timestamp
 */
function autoLayerName(draft: QueryDraft): string {
  const labels = draft.selectedSubjectIds
    .map((id) => SUBJECT_CATALOG.find((s) => s.id === id)?.label)
    .filter((l): l is string => typeof l === "string");

  let base: string;
  if (labels.length === 0) {
    base = "Untitled query";
  } else if (labels.length === 1) {
    base = labels[0];
  } else if (labels.length === 2) {
    base = `${labels[0]} + ${labels[1]}`;
  } else {
    base = `${labels[0]} + ${labels.length - 1} more`;
  }

  const region = draft.regionLabel?.split(",")[0]?.trim();
  return region ? `${base} — ${region}` : base;
}

function SourcePip({ kind }: { kind: "query" | "upload" }) {
  const label = kind === "query" ? "from query" : "from KML upload";
  const color =
    kind === "query"
      ? "border-[var(--color-accent)] text-[var(--color-accent)]"
      : "border-[var(--color-line-strong)] text-[var(--color-ink-faint)]";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0 uppercase ${color}`}
      style={{ fontSize: "9px", letterSpacing: "0.16em" }}
    >
      {label}
    </span>
  );
}
