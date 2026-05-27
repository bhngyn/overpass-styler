import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { THEMES, themeById } from "@/lib/palettes";
import { useProjectStore } from "@/stores/project";
import { ProjectTree } from "./ProjectTree";
import { MapPreview } from "./MapPreview";
import { ContextPanel } from "./ContextPanel";
import { ComposeStep } from "./ComposeStep";
import { ReviewLeftRail, ReviewRightRail } from "./ReviewStep";
import { ExportLeftRail, ExportRightRail } from "./ExportStep";
import { Stepper } from "./Stepper";
import { TagLibraryDrawer } from "./TagLibraryDrawer";
import { TitleBarCompass } from "./TitleBarCompass";

/**
 * ProjectWorkspace — the four-step workflow shell.
 *
 * Key invariant: the `<MapPreview />` instance is rendered exactly once in the
 * JSX tree across every step, so MapLibre's GL context is never thrown away
 * mid-workflow. The left/right *rails* swap based on `workflowStep`, but the
 * map cell sits in a stable position in the grid.
 *
 * Compose deviates slightly from the three-pane shape — its left rail (layer
 * stack) and right rail (query editor) come bundled as one component (which
 * already paints its own internal divider), so we render it as a single flex
 * block taking the space that would otherwise hold ProjectTree + ContextPanel,
 * with the map dropping to the right side at a fixed reasonable width.
 */
export function ProjectWorkspace() {
  const proj = useProjectStore((s) => s.currentProject);
  const sourceFiles = useProjectStore((s) => s.sourceFiles);
  const close = useProjectStore((s) => s.closeProject);
  const rename = useProjectStore((s) => s.renameProject);
  const deleteProject = useProjectStore((s) => s.deleteCurrentProject);
  const busy = useProjectStore((s) => s.busy);
  const themeId = useProjectStore((s) => s.themeId);
  const applyTheme = useProjectStore((s) => s.applyTheme);
  const setAllVisible = useProjectStore((s) => s.setAllVisible);
  const hiddenCategoriesCount = useProjectStore(
    (s) => s.hiddenCategories.size + s.hiddenSourceFiles.size,
  );
  const setMode = useProjectStore((s) => s.setMode);
  const workflowStep = useProjectStore((s) => s.workflowStep);
  const setWorkflowStep = useProjectStore((s) => s.setWorkflowStep);

  // Distinct category keys across the project's files. Prefer the freshly
  // detailed value (covers legacy rows where the summary is still null) and
  // fall back to the summary so we don't flicker before details load.
  const distinctCategoryKeys = useMemo(() => {
    if (!proj) return [] as string[];
    const seen: string[] = [];
    for (const sf of proj.source_files) {
      const key = sourceFiles[sf.id]?.category_key ?? sf.category_key;
      if (key && !seen.includes(key)) seen.push(key);
    }
    return seen;
  }, [proj, sourceFiles]);

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(proj?.name ?? "");

  useEffect(() => {
    setDraftName(proj?.name ?? "");
  }, [proj?.name]);

  // Tag Library drawer wiring. ProjectWorkspace owns the open/closed state and
  // exposes an `onOpenTagLibrary` callback to ComposeStep (which forwards it
  // to QueryEditor's "Tag Library" button).
  //
  // The drawer's `onInsert` callback needs to reach the active QueryEditor
  // textarea. The drawer is owned by B3, the editor by B1 — we (B5) own
  // neither. The minimum-viable seam is a DOM-only handler:
  //
  //   1. When the user clicks "Tag Library" inside QueryEditor, the textarea
  //      is the active element. We capture that node into a ref *before*
  //      opening the drawer, so the focus jump into the drawer doesn't lose
  //      it.
  //   2. When the drawer fires onInsert, we splice the clause into that
  //      textarea at the current cursor and dispatch a native `input` event,
  //      which React picks up via the textarea's onChange handler. The
  //      QueryEditor state updates without any cross-component plumbing.
  //
  // This avoids modifying ComposeStep or QueryEditor at the cost of a
  // shallow DOM coupling. The coupling is acceptable because there is at
  // most one QueryEditor textarea on screen when the drawer is open — its
  // DOM identity is unambiguous via the captured ref.
  //
  // We track the insert target via a document-level focus/click listener
  // that records every textarea tagged ``data-tag-insert-target="true"`` as
  // it receives focus. Reading ``document.activeElement`` at button-click
  // time (the previous implementation) was brittle: Chromium moves focus to
  // the button mid-click, and Safari/Firefox never focus buttons at all, so
  // the ref captured was often null. With the listener pattern, opening
  // the drawer from a touch user / a stale page state still finds the most
  // recently used QL editor. D2 review #2 / D3 review #1b.
  const [tagLibOpen, setTagLibOpen] = useState(false);
  const [tagLibInsertError, setTagLibInsertError] = useState<string | null>(null);
  const insertTargetRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    function trackTouch(e: Event) {
      const el = e.target;
      if (
        el instanceof HTMLTextAreaElement &&
        el.dataset.tagInsertTarget === "true"
      ) {
        insertTargetRef.current = el;
      }
    }
    // focusin bubbles (unlike focus); pointerdown covers touch interactions
    // that don't immediately move keyboard focus.
    document.addEventListener("focusin", trackTouch, true);
    document.addEventListener("pointerdown", trackTouch, true);
    return () => {
      document.removeEventListener("focusin", trackTouch, true);
      document.removeEventListener("pointerdown", trackTouch, true);
    };
  }, []);

  const openTagLibrary = useCallback(() => {
    // Fallback: if no textarea has been touched yet (e.g. investigator
    // opened a fresh draft and immediately clicked "Tag Library"), grab
    // the only visible tag-insert target — DOM-unique by design.
    if (!insertTargetRef.current) {
      const found = document.querySelector<HTMLTextAreaElement>(
        'textarea[data-tag-insert-target="true"]',
      );
      if (found) insertTargetRef.current = found;
    }
    setTagLibInsertError(null);
    setTagLibOpen(true);
  }, []);
  const onInsertFromDrawer = useCallback((clause: string) => {
    const ta = insertTargetRef.current;
    if (!ta || !ta.isConnected) {
      // Drawer was opened from somewhere that never had a target (e.g. a
      // future caller outside QueryEditor) or the textarea unmounted while
      // the drawer was open (step switch). Tell the user instead of
      // silently swallowing.
      setTagLibInsertError(
        "No active query editor to insert into. Open a Compose draft and click into the query text first.",
      );
      return;
    }
    setTagLibInsertError(null);
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const next = before + clause + after;
    // React tracks controlled-input values via a hidden value-tracker; the
    // standard workaround is to call the native value setter and then
    // dispatch an "input" event so React's onChange fires with `next`.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(ta, next);
    else ta.value = next;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    // Restore cursor after the inserted clause.
    requestAnimationFrame(() => {
      const pos = before.length + clause.length;
      ta.setSelectionRange(pos, pos);
      ta.focus();
    });
  }, []);

  if (!proj) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-ink-faint)]">
        Loading project…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Title bar */}
      <header className="flex shrink-0 flex-col gap-2 border-b border-[var(--color-line)] bg-[var(--color-surface-raised)] px-4 pt-2 pb-1">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={close}
              className="text-xs uppercase tracking-wider text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            >
              ← All projects
            </button>
            <span className="text-[var(--color-line)]">·</span>
            <TitleBarCompass />
            {editingName ? (
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.currentTarget.value)}
                onBlur={async () => {
                  if (draftName.trim() && draftName !== proj.name) await rename(draftName.trim());
                  setEditingName(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    setDraftName(proj.name);
                    setEditingName(false);
                  }
                }}
                // min-w-[20rem] keeps long project names from clipping in
                // the rename input. We size to the content via the value
                // length too, so a short name doesn't waste space.
                size={Math.max(draftName.length + 1, 24)}
                className="min-w-[20rem] rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-sm"
              />
            ) : (
              // Rendered as a <button> styled like a heading so keyboard users
              // can rename via Tab + Enter / Space; <h1 onClick> wasn't
              // reachable. The visual treatment is unchanged.
              <h1 className="font-[var(--font-display)] text-base text-[var(--color-ink)]">
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  aria-label={`Rename project — current name ${proj.name}`}
                  title="Rename project"
                  className="cursor-text rounded text-left text-[var(--color-ink)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                >
                  {proj.name}
                </button>
              </h1>
            )}
            {distinctCategoryKeys.length > 0 && (
              <span className="text-xs text-[var(--color-ink-faint)]">
                grouped by{" "}
                {distinctCategoryKeys.map((key, i) => (
                  <span key={key}>
                    {i > 0 && <span className="mx-1">·</span>}
                    <code className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-soft)]">
                      {key}
                    </code>
                  </span>
                ))}
              </span>
            )}
            {busy && <span className="text-xs text-[var(--color-ink-faint)]">working…</span>}
          </div>

          <div className="flex items-center gap-2">
            {/* Mode toggle — Project / Browse. */}
            <ModeToggle
              current="project"
              onSwitch={(next) => {
                if (next === "browse") setMode("browse");
              }}
            />

            {/* Theme picker — applies a palette to all current categories. */}
            <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1">
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                theme
              </span>
              <select
                value={themeId}
                onChange={(e) => applyTheme(e.currentTarget.value)}
                title={themeById(themeId).description}
                className="bg-transparent text-xs text-[var(--color-ink)] focus:outline-none"
              >
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id} title={t.description}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            {hiddenCategoriesCount > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setAllVisible(true)}>
                Show all ({hiddenCategoriesCount} hidden)
              </Button>
            )}

            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (confirm(`Delete project "${proj.name}"? This cannot be undone.`)) {
                  deleteProject();
                }
              }}
            >
              Delete project
            </Button>
          </div>
        </div>

        {/* Stepper rail — below the title row so the project name stays the
            visual anchor. The stepper itself owns its padding; we just
            constrain max-width so it doesn't span an enormous screen. */}
        <div className="mx-auto w-full max-w-3xl">
          <Stepper current={workflowStep} onChange={setWorkflowStep} />
        </div>
      </header>

      {/* Step-routed body. The MapPreview is rendered as a single conditional
          subtree below — but we keep its component identity stable across
          steps by always mounting it in the same React position (the centre
          cell) and only changing the surrounding rail components. */}
      <WorkspaceBody step={workflowStep} onOpenTagLibrary={openTagLibrary} />

      {/* Tag Library drawer — always mounted, animates open/closed. */}
      <TagLibraryDrawer
        open={tagLibOpen}
        onClose={() => {
          setTagLibOpen(false);
          setTagLibInsertError(null);
        }}
        onInsert={onInsertFromDrawer}
      />

      {/* Surface insertion failures (no active target) as a transient toast
          so investigators don't quietly lose their click. Auto-dismisses. */}
      {tagLibInsertError && (
        <div
          role="alert"
          className="fixed bottom-6 right-6 z-50 max-w-md rounded-md border border-[var(--color-warning)]/40 bg-[var(--paper-warm)] px-4 py-3 text-sm text-[var(--ink-dark)] shadow-lg"
        >
          {tagLibInsertError}
          <button
            type="button"
            onClick={() => setTagLibInsertError(null)}
            className="ml-3 text-xs underline opacity-70 hover:opacity-100"
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * WorkspaceBody — the step-routed centre of the workspace.
 *
 * Three-pane grid for style/review/export (rails swap, map stays put). Compose
 * uses a two-block flex layout (ComposeStep handles its own internal split;
 * we just put the map on the right).
 *
 * MapPreview is mounted in exactly one place in this component's return tree
 * per render path, so React preserves its instance across step transitions as
 * long as the user stays inside the same step *family*. Switching into or out
 * of Compose does remount the map — acceptable, as the GL context init is
 * fast and the compose step's layout would otherwise need to compromise.
 */
function WorkspaceBody({
  step,
  onOpenTagLibrary,
}: {
  step: "compose" | "style" | "review" | "export";
  onOpenTagLibrary: () => void;
}) {
  if (step === "compose") {
    // Compose is map-first: investigators are picking a region and previewing
    // an Overpass result, so the map is the priority surface. ComposeStep
    // paints its own 280px layer-stack rail + the query column; together they
    // take a fixed ~740px and the map fills everything else. This means the
    // map does visually grow when crossing into Compose from Style/Review/
    // Export (400px right rail there) — accepted, since Compose's job is
    // different from the other steps.
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 w-[720px] shrink-0">
          <ComposeStep onOpenTagLibrary={onOpenTagLibrary} />
        </div>
        <aside className="relative min-h-0 min-w-0 flex-1 border-l border-[var(--color-line)] bg-[#eae6dc]">
          <MapPreview />
        </aside>
      </div>
    );
  }

  let leftRail: React.ReactNode = null;
  let rightRail: React.ReactNode = null;
  if (step === "style") {
    leftRail = <ProjectTree />;
    rightRail = <ContextPanel />;
  } else if (step === "review") {
    leftRail = <ReviewLeftRail />;
    rightRail = <ReviewRightRail />;
  } else if (step === "export") {
    leftRail = <ExportLeftRail />;
    rightRail = <ExportRightRail />;
  }

  // Three-pane grid. minmax(0,1fr) on the row template so the row fills the
  // grid's height rather than collapsing to fit-content — without that the
  // middle cell would size to its absolute child (height 0) and the map would
  // render invisibly.
  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-[280px_1fr_400px] overflow-hidden"
      style={{ gridTemplateRows: "minmax(0, 1fr)" }}
    >
      <aside className="min-h-0 overflow-y-auto border-r border-[var(--color-line)] bg-[var(--color-surface-sunken)]">
        {leftRail}
      </aside>
      <main className="relative min-h-0 min-w-0 overflow-hidden bg-[#eae6dc]">
        <MapPreview />
      </main>
      <aside className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-surface-raised)]">
        {rightRail}
      </aside>
    </div>
  );
}

interface ModeToggleProps {
  current: "project" | "browse";
  onSwitch: (mode: "project" | "browse") => void;
}

/** Segmented control: Project · Browse. The active mode is rendered as a
 * filled pill; the inactive one as a quiet ghost. Click-anywhere flips. */
function ModeToggle({ current, onSwitch }: ModeToggleProps) {
  return (
    <div
      role="group"
      aria-label="Top-level destination"
      className="inline-flex items-center rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] p-0.5"
    >
      <button
        type="button"
        onClick={() => onSwitch("project")}
        aria-pressed={current === "project"}
        className={[
          "rounded-[5px] px-2 py-0.5 text-[11px] transition-colors",
          current === "project"
            ? "bg-[var(--color-surface-raised)] text-[var(--color-ink)] shadow-sm"
            : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-soft)]",
        ].join(" ")}
      >
        <span aria-hidden className="mr-1">📓</span>Project
      </button>
      <button
        type="button"
        onClick={() => onSwitch("browse")}
        aria-pressed={current === "browse"}
        className={[
          "rounded-[5px] px-2 py-0.5 text-[11px] transition-colors",
          current === "browse"
            ? "bg-[var(--color-surface-raised)] text-[var(--color-ink)] shadow-sm"
            : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-soft)]",
        ].join(" ")}
      >
        <span aria-hidden className="mr-1">🗺</span>Browse
      </button>
    </div>
  );
}
