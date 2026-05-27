// Step 3 — Review. Preflight check before export.
//
// Layout (rails only — the map is mounted by the workflow's parent):
//   ┌── left rail ────┐  ┌── (map lives in centre, owned by parent) ──┐
//   │ LEGEND          │
//   │   • categories  │
//   │     w/ icon,    │
//   │     swatch,     │
//   │     count, eye  │
//   └─────────────────┘
//                                              ┌── right rail ─────────┐
//                                              │ CHECKLIST             │
//                                              │   ✓ styles assigned   │
//                                              │   ✓ layers have data  │
//                                              │   ⚠ low-source rows   │
//                                              │   ⚠ hidden cats       │
//                                              │ BALLOON PREVIEW       │
//                                              │   [iframe]            │
//                                              └───────────────────────┘
//
// The component renders **only** the rails; the centre pane is handled by
// `ProjectWorkspace` / `MapPreview` (which stays mounted across steps so
// MapLibre's GL context never restarts). The Review step exports two sub-
// components — `ReviewLeftRail` and `ReviewRightRail` — so the parent can
// slot them into the three-pane grid alongside the map.

import { useMemo } from "react";
import { useProjectStore } from "@/stores/project";
import type { PlacemarkPreview, SourceFileDetail } from "@/lib/types";
import { MapLegend } from "./MapLegend";
import { BalloonPreview } from "./BalloonPreview";

/** Convenience grouping so a caller can mount both rails without thinking
 * about which selectors each one wants. Useful when a future iteration
 * collapses the rails into a tabbed UI for narrow viewports. */
export function ReviewStep() {
  return (
    <>
      <ReviewLeftRail />
      <ReviewRightRail />
    </>
  );
}

/** Left rail — the promoted Legend. Same component the map renders in its
 * floating chip, but in "rail" placement so it spans the rail's full width
 * and skips the floating-card chrome. */
export function ReviewLeftRail() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <Eyebrow>Legend</Eyebrow>
      <p className="mb-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
        Click a row to focus the map on that category. Use the eye toggle to
        hide a layer without removing it.
      </p>
      <MapLegend placement="rail" />
    </div>
  );
}

/** Right rail — Checklist (auto-derived signals) + Balloon Preview. */
export function ReviewRightRail() {
  const proj = useProjectStore((s) => s.currentProject);
  const sourceFiles = useProjectStore((s) => s.sourceFiles);
  const selection = useProjectStore((s) => s.selection);
  const hiddenCategories = useProjectStore((s) => s.hiddenCategories);
  const hiddenSourceFiles = useProjectStore((s) => s.hiddenSourceFiles);
  const styleForCategory = useProjectStore((s) => s.styleForCategory);

  const findings = useMemo(() => {
    if (!proj) return null;
    return computeReviewFindings({
      proj,
      sourceFiles,
      hiddenCategories,
      hiddenSourceFiles,
    });
  }, [proj, sourceFiles, hiddenCategories, hiddenSourceFiles]);

  /** Pick the placemark to preview: the current selection if it's a single
   * placemark, else the first placemark in the project (stable order: lowest
   * source-file id, lowest placemark index). */
  const previewTarget = useMemo(() => {
    if (!proj) return null;
    if (selection.kind === "placemark") {
      const detail = sourceFiles[selection.sourceFileId];
      const pm = detail?.placemarks.find((p) => p.index === selection.placemarkIndex);
      if (pm) return { detail, placemark: pm } as const;
    }
    const sortedSf = [...proj.source_files].sort((a, b) => a.id - b.id);
    for (const sf of sortedSf) {
      const detail = sourceFiles[sf.id];
      if (detail && detail.placemarks.length > 0) {
        const sorted = [...detail.placemarks].sort((a, b) => a.index - b.index);
        return { detail, placemark: sorted[0] } as const;
      }
    }
    return null;
  }, [proj, sourceFiles, selection]);

  if (!proj) return null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <section>
        <Eyebrow>Checklist</Eyebrow>
        {findings && findings.items.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {findings.items.map((f, i) => (
              <li
                key={`${f.kind}-${i}`}
                className={[
                  "flex items-start gap-2 rounded border px-2.5 py-2 text-xs leading-relaxed",
                  f.kind === "ok"
                    ? "border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-ink-soft)]"
                    : "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 text-[var(--color-ink)]",
                ].join(" ")}
              >
                <span
                  className={[
                    "mt-0.5 inline-block w-3 shrink-0 text-center font-semibold",
                    f.kind === "ok"
                      ? "text-[var(--color-success)]"
                      : "text-[var(--color-warning)]",
                  ].join(" ")}
                  aria-hidden="true"
                >
                  {f.kind === "ok" ? "✓" : "⚠"}
                </span>
                <span className="flex-1">
                  <span className="font-medium">{f.title}</span>
                  {f.detail ? (
                    <span className="ml-1 text-[var(--color-ink-faint)]">
                      {f.detail}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
            Nothing to check yet — import a KML to begin.
          </p>
        )}
      </section>

      <section>
        <Eyebrow>Balloon preview</Eyebrow>
        <p className="mt-1 mb-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          Approximate of the popup Earth Pro shows when an investigator clicks
          this placemark. The exported balloon is generated server-side and
          uses the same design.
        </p>
        {previewTarget ? (
          <>
            <div className="mb-2 text-[11px] text-[var(--color-ink-soft)]">
              Previewing{" "}
              <span className="font-medium text-[var(--color-ink)]">
                {previewTarget.placemark.name ?? `Placemark #${previewTarget.placemark.index}`}
              </span>{" "}
              from{" "}
              <span className="font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
                {previewTarget.detail?.filename}
              </span>
            </div>
            <BalloonPreview
              style={styleForCategory(previewTarget.placemark.category_value ?? "")}
              placemark={previewTarget.placemark}
              categoryLabel={
                previewTarget.detail?.category_key && previewTarget.placemark.category_value
                  ? `${previewTarget.detail.category_key}=${previewTarget.placemark.category_value}`
                  : previewTarget.placemark.category_value ?? "Feature"
              }
            />
          </>
        ) : (
          <p className="rounded border border-dashed border-[var(--color-line)] px-3 py-4 text-xs text-[var(--color-ink-faint)]">
            No placemarks to preview. Import a KML first.
          </p>
        )}
      </section>
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
      {children}
    </div>
  );
}

/** A single line item in the checklist — either a green-tick OK or a warning. */
type Finding =
  | { kind: "ok"; title: string; detail?: string }
  | { kind: "warn"; title: string; detail?: string };

/** Run the heuristic checks. Pure function so it stays trivially testable
 * (no DOM, no store) once we want to. */
export function computeReviewFindings(args: {
  proj: import("@/lib/types").ProjectDetail;
  sourceFiles: Record<number, SourceFileDetail>;
  hiddenCategories: Set<string>;
  hiddenSourceFiles: Set<number>;
}): { items: Finding[] } {
  const { proj, sourceFiles, hiddenCategories, hiddenSourceFiles } = args;
  const items: Finding[] = [];

  // Aggregate counts per category across source files.
  const aggregate: Record<string, number> = {};
  for (const sf of proj.source_files) {
    const d = sourceFiles[sf.id];
    if (!d) continue;
    for (const [v, n] of Object.entries(d.category_counts)) {
      aggregate[v] = (aggregate[v] ?? 0) + n;
    }
  }

  // ✓ Every category has a saved style.
  const allCategoryValues = Object.keys(aggregate);
  const unstyled = allCategoryValues.filter((v) => !proj.category_styles[v]);
  if (allCategoryValues.length === 0) {
    items.push({
      kind: "warn",
      title: "No categories yet",
      detail: "Import a KML to begin grouping placemarks.",
    });
  } else if (unstyled.length === 0) {
    items.push({
      kind: "ok",
      title: `All ${allCategoryValues.length} categories have a saved style.`,
    });
  } else {
    items.push({
      kind: "warn",
      title: `${unstyled.length} categor${unstyled.length === 1 ? "y" : "ies"} need styling`,
      detail: unstyled.slice(0, 3).join(", ") + (unstyled.length > 3 ? "…" : ""),
    });
  }

  // ✓ Every source file has at least one placemark.
  const emptySources = proj.source_files.filter((sf) => {
    const d = sourceFiles[sf.id];
    if (!d) return false;
    return d.placemarks.length === 0;
  });
  if (proj.source_files.length === 0) {
    // already covered above
  } else if (emptySources.length === 0) {
    items.push({
      kind: "ok",
      title: `All ${proj.source_files.length} layer${proj.source_files.length === 1 ? "" : "s"} contain placemarks.`,
    });
  } else {
    items.push({
      kind: "warn",
      title: `${emptySources.length} empty layer${emptySources.length === 1 ? "" : "s"}`,
      detail: emptySources.map((sf) => sf.filename).slice(0, 3).join(", "),
    });
  }

  // ⚠︎ Layers where >50% of placemarks have empty source_url annotation.
  const lowSourceLayers: { name: string; missing: number; total: number }[] = [];
  for (const sf of proj.source_files) {
    const d = sourceFiles[sf.id];
    if (!d || d.placemarks.length === 0) continue;
    const missing = d.placemarks.filter(
      (p: PlacemarkPreview) => !(p.annotations?.["source_url"] ?? "").trim(),
    ).length;
    if (missing / d.placemarks.length > 0.5) {
      lowSourceLayers.push({ name: sf.filename, missing, total: d.placemarks.length });
    }
  }
  if (lowSourceLayers.length > 0) {
    const summary = lowSourceLayers
      .slice(0, 2)
      .map((l) => `${l.name} (${l.missing}/${l.total})`)
      .join(", ");
    items.push({
      kind: "warn",
      title: `Source URL missing on majority of placemarks in ${lowSourceLayers.length} layer${lowSourceLayers.length === 1 ? "" : "s"}`,
      detail: summary + (lowSourceLayers.length > 2 ? "…" : ""),
    });
  }

  // ⚠︎ Hidden categories — flag them so investigators don't forget toggles.
  const hidden: string[] = [];
  for (const v of hiddenCategories) hidden.push(v);
  if (hiddenSourceFiles.size > 0) {
    const names = proj.source_files
      .filter((sf) => hiddenSourceFiles.has(sf.id))
      .map((sf) => sf.filename);
    if (names.length > 0) {
      items.push({
        kind: "warn",
        title: `${names.length} layer${names.length === 1 ? " is" : "s are"} hidden`,
        detail: names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : ""),
      });
    }
  }
  if (hidden.length > 0) {
    items.push({
      kind: "warn",
      title: `${hidden.length} categor${hidden.length === 1 ? "y is" : "ies are"} hidden`,
      detail: hidden.slice(0, 3).join(", ") + (hidden.length > 3 ? "…" : ""),
    });
  }

  return { items };
}
