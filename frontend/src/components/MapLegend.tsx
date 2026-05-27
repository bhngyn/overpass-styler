import { useMemo, useState } from "react";
import { useProjectStore } from "@/stores/project";
import { rgbaToCss } from "@/lib/kmlColor";
import type { SourceFileDetail } from "@/lib/types";

/** Where this legend instance is being mounted. The same component serves
 * two roles:
 *
 *  - **"map"** — the original floating chip in the top-right of MapPreview
 *    that Step 2 (Style) investigators expect to see while they're tuning
 *    individual category styles.
 *  - **"rail"** — the full-bleed list rendered in the left rail of the
 *    Review step. The rail variant drops the floating-card chrome (no
 *    absolute positioning, no card border, no max-height scroll cap) and
 *    leans on the surrounding container for its visual frame.
 *
 * Keeping both behaviours in one component means a future tweak to the
 * row layout (swatch, icon, count, eye toggle) lands in both spots for
 * free. */
export type LegendPlacement = "map" | "rail";

interface LegendProps {
  placement: LegendPlacement;
  /** Whether the floating "map" variant is currently collapsed. Ignored in
   * "rail" mode where there's nothing to collapse — the rail expects to
   * always be visible. */
  collapsed?: boolean;
  onToggle?: () => void;
}

/** Compound key for the expand-state Set — needs both source file id and
 * category value so the same category value in two different source files
 * expands independently. */
function expandKey(sourceFileId: number, value: string): string {
  return `${sourceFileId}|${value}`;
}

/** Legend — lists every category visible in the project with its swatch and
 * feature count. Click a row to toggle that category's visibility on the
 * map. Used both as the floating chip on the map (Step 2 — Style) and as
 * the left-rail diagnostic in Step 3 — Review.
 *
 * In `rail` placement, each category row carries an expand chevron that
 * reveals the placemark list inside that category — Review step uses this
 * to preflight individual features without leaving the legend. */
export function MapLegend({ placement, collapsed = false, onToggle }: LegendProps) {
  const proj = useProjectStore((s) => s.currentProject);
  const sourceFiles = useProjectStore((s) => s.sourceFiles);
  const selection = useProjectStore((s) => s.selection);
  const hiddenCategories = useProjectStore((s) => s.hiddenCategories);
  const hiddenSourceFiles = useProjectStore((s) => s.hiddenSourceFiles);
  const toggleCategoryVisible = useProjectStore((s) => s.toggleCategoryVisible);
  const styleForCategory = useProjectStore((s) => s.styleForCategory);
  const setSelection = useProjectStore((s) => s.setSelection);
  /** Rail-only: which (source-file, category) rows are expanded to show
   * their placemarks. Kept in component state — view concern only. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (sourceFileId: number, value: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const k = expandKey(sourceFileId, value);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  if (!proj) return null;

  // Group categories by source file so the legend reads as a hierarchy.
  const groups = proj.source_files
    .map((sf) => {
      const detail = sourceFiles[sf.id];
      if (!detail) return null;
      const entries = Object.entries(detail.category_counts).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (entries.length === 0) return null;
      return {
        sf,
        entries,
        hidden: hiddenSourceFiles.has(sf.id),
      };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null);

  if (groups.length === 0) return null;

  if (placement === "rail") {
    return (
      <div className="space-y-3">
        {groups.map(({ sf, entries, hidden }) => {
          const detail = sourceFiles[sf.id];
          return (
            <div key={sf.id} className="space-y-1">
              <div
                className={[
                  "truncate text-[11px] font-medium text-[var(--color-ink-soft)]",
                  hidden ? "opacity-50" : "",
                ].join(" ")}
                title={sf.filename}
              >
                {sf.filename}
              </div>
              <div className="space-y-0.5">
                {entries.map(([value, count]) => {
                  const isExpanded = expanded.has(expandKey(sf.id, value));
                  return (
                    <div key={value}>
                      <LegendRow
                        sourceFileId={sf.id}
                        value={value}
                        count={count}
                        hidden={hidden || hiddenCategories.has(value)}
                        variant="rail"
                        expandable
                        isExpanded={isExpanded}
                        onToggleExpanded={() => toggleExpanded(sf.id, value)}
                        onToggleVisible={() => toggleCategoryVisible(value)}
                        onSelect={() =>
                          setSelection({
                            kind: "category",
                            sourceFileId: sf.id,
                            categoryValue: value,
                          })
                        }
                        styleForCategory={styleForCategory}
                      />
                      {isExpanded && detail && (
                        <RailPlacemarkList
                          detail={detail}
                          categoryValue={value}
                          selection={selection}
                          onSelect={setSelection}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // placement === "map" — floating, collapsible chip.
  return (
    <div className="absolute right-3 top-3 max-w-xs rounded-md border border-[var(--color-line)] bg-white/95 text-xs shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
      >
        <span>Legend</span>
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[60vh] overflow-y-auto px-3 pb-3">
          {groups.map(({ sf, entries, hidden }) => (
            <div key={sf.id} className="mt-1 space-y-0.5">
              <div
                className={[
                  "truncate text-[11px] font-medium",
                  hidden ? "opacity-50" : "",
                ].join(" ")}
                title={sf.filename}
              >
                {sf.filename}
              </div>
              <div className="space-y-0.5">
                {entries.map(([value, count]) => (
                  <LegendRow
                    key={value}
                    sourceFileId={sf.id}
                    value={value}
                    count={count}
                    hidden={hidden || hiddenCategories.has(value)}
                    variant="map"
                    onToggleVisible={() => toggleCategoryVisible(value)}
                    styleForCategory={styleForCategory}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="mt-2 border-t border-[var(--color-line)] pt-1.5 text-[10px] text-[var(--color-ink-faint)]">
            Click a swatch to hide/show that layer on the map.
          </div>
        </div>
      )}
    </div>
  );
}

interface LegendRowProps {
  sourceFileId: number;
  value: string;
  count: number;
  hidden: boolean;
  variant: "map" | "rail";
  onToggleVisible: () => void;
  /** Rail-only: clicking the row body (not the eye button) selects the
   * category, which the map's existing selection-effect picks up and reacts
   * to (thicker outline, larger point). */
  onSelect?: () => void;
  styleForCategory: (value: string) => import("@/lib/types").FeatureStyle;
  /** Rail-only: when true, prepend a chevron toggle that expands a
   * placemark list under this row. The parent owns the open/closed state. */
  expandable?: boolean;
  isExpanded?: boolean;
  onToggleExpanded?: () => void;
}

function LegendRow({
  sourceFileId: _sourceFileId,
  value,
  count,
  hidden,
  variant,
  onToggleVisible,
  onSelect,
  styleForCategory,
  expandable = false,
  isExpanded = false,
  onToggleExpanded,
}: LegendRowProps) {
  const style = styleForCategory(value);
  const fill = rgbaToCss(style.polygon.fill_color);
  const outline = rgbaToCss(style.polygon.outline_color);
  const iconHref = style.icon.icon_href;
  // void to satisfy "noUnusedParameters" without renaming the prop API.
  void _sourceFileId;

  if (variant === "map") {
    // Compact, single-click toggles visibility (preserves original UX).
    return (
      <button
        type="button"
        onClick={onToggleVisible}
        title={hidden ? `Show ${value}` : `Hide ${value}`}
        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-[var(--color-surface-sunken)]"
      >
        <span
          className="block h-3 w-3 shrink-0 rounded-sm border"
          style={{
            backgroundColor: fill,
            borderColor: outline,
            opacity: hidden ? 0.25 : 1,
          }}
        />
        <span
          className={[
            "truncate font-[var(--font-mono)] text-[11px]",
            hidden
              ? "text-[var(--color-ink-faint)] line-through"
              : "text-[var(--color-ink)]",
          ].join(" ")}
        >
          {value}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-[var(--color-ink-faint)]">
          {count}
        </span>
      </button>
    );
  }

  // Rail variant — slightly more spacious row with icon thumbnail, swatch,
  // name + count, then a separate eye-toggle button.
  return (
    <div
      className={[
        "group flex w-full items-center gap-1 rounded px-1.5 py-1 text-left",
        "hover:bg-[var(--color-surface-sunken)]",
      ].join(" ")}
    >
      {expandable && (
        <button
          type="button"
          onClick={onToggleExpanded}
          title={isExpanded ? `Hide placemarks in ${value}` : `Show placemarks in ${value}`}
          aria-label={isExpanded ? `Collapse ${value}` : `Expand ${value}`}
          aria-expanded={isExpanded}
          className="w-3 shrink-0 text-[10px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
        >
          {isExpanded ? "▾" : "▸"}
        </button>
      )}
      <button
        type="button"
        onClick={onSelect}
        className="flex flex-1 items-center gap-2 text-left"
        title={`Focus ${value}`}
      >
        {iconHref ? (
          <img
            src={iconHref}
            alt=""
            className="h-4 w-4 shrink-0"
            style={{ opacity: hidden ? 0.25 : 1 }}
            // Fallback: hide a missing icon silently so the swatch still reads.
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
            }}
          />
        ) : null}
        <span
          className="block h-3 w-3 shrink-0 rounded-sm border"
          style={{
            backgroundColor: fill,
            borderColor: outline,
            opacity: hidden ? 0.25 : 1,
          }}
        />
        <span
          className={[
            "truncate font-[var(--font-mono)] text-[11px]",
            hidden
              ? "text-[var(--color-ink-faint)] line-through"
              : "text-[var(--color-ink)]",
          ].join(" ")}
        >
          {value}
        </span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-[var(--color-ink-faint)]">
          {count}
        </span>
      </button>
      <button
        type="button"
        onClick={onToggleVisible}
        title={hidden ? `Show ${value}` : `Hide ${value}`}
        aria-label={hidden ? `Show ${value}` : `Hide ${value}`}
        className="shrink-0 rounded px-1 text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
      >
        {hidden ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

/** Placemark roster shown inline under an expanded category row in the
 * Review-step rail. Mirrors the visual rhythm of ProjectTree's
 * `PlacemarkList` so users moving between Compose/Style and Review see the
 * same affordances. Clicking a placemark routes through the existing
 * selection flow — the map flies to it and the right-rail balloon preview
 * updates. */
function RailPlacemarkList({
  detail,
  categoryValue,
  selection,
  onSelect,
}: {
  detail: SourceFileDetail;
  categoryValue: string;
  selection: ReturnType<typeof useProjectStore.getState>["selection"];
  onSelect: ReturnType<typeof useProjectStore.getState>["setSelection"];
}) {
  const items = useMemo(
    () =>
      detail.placemarks
        .filter((p) => p.category_value === categoryValue)
        .sort((a, b) => a.index - b.index),
    [detail.placemarks, categoryValue],
  );
  if (items.length === 0) {
    return (
      <p className="ml-5 mt-0.5 py-1 text-[11px] italic text-[var(--color-ink-faint)]">
        No placemarks in this category.
      </p>
    );
  }
  return (
    <ul className="ml-3 mt-0.5 max-h-60 space-y-0.5 overflow-y-auto border-l border-[var(--color-line)] pl-2">
      {items.map((p) => {
        const isSelected =
          selection.kind === "placemark" &&
          selection.sourceFileId === detail.id &&
          selection.placemarkIndex === p.index;
        // Prefer the placemark's own name; fall back through localised
        // OSM name tags before showing the raw index. Matches ProjectTree.
        const label =
          p.name?.trim() ||
          p.extended_data["name:en"]?.trim() ||
          p.extended_data["name:fr"]?.trim() ||
          p.extended_data["name:ar"]?.trim() ||
          `#${p.index}`;
        return (
          <li key={p.index}>
            <button
              type="button"
              onClick={() =>
                onSelect({
                  kind: "placemark",
                  sourceFileId: detail.id,
                  placemarkIndex: p.index,
                })
              }
              className={[
                "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px]",
                isSelected
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-ink)]"
                  : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-raised)]",
              ].join(" ")}
            >
              <span className="truncate">{label}</span>
              {p.has_override && (
                <span
                  title="Has per-placemark style override"
                  className="ml-auto text-[10px] text-[var(--color-accent)]"
                >
                  ⚑
                </span>
              )}
              {Object.keys(p.annotations).length > 0 && (
                <span
                  title="Has annotations"
                  className={[
                    "text-[10px] text-[var(--color-success)]",
                    p.has_override ? "" : "ml-auto",
                  ].join(" ")}
                >
                  ✎
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EyeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a18.7 18.7 0 0 1 4.06-5.06" />
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c6.5 0 10 7 10 7a18.7 18.7 0 0 1-2.16 3" />
      <path d="m1 1 22 22" />
      <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
    </svg>
  );
}
