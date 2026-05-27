import { useMemo, useRef, useState } from "react";
import { useProjectStore } from "@/stores/project";
import { rgbaToCss } from "@/lib/kmlColor";
import { defaultFeatureStyle } from "@/lib/defaults";

export function ProjectTree() {
  const proj = useProjectStore((s) => s.currentProject);
  const sourceFiles = useProjectStore((s) => s.sourceFiles);
  const selection = useProjectStore((s) => s.selection);
  const setSelection = useProjectStore((s) => s.setSelection);
  const deleteSourceFile = useProjectStore((s) => s.deleteSourceFile);
  const hiddenSourceFiles = useProjectStore((s) => s.hiddenSourceFiles);
  const hiddenCategories = useProjectStore((s) => s.hiddenCategories);
  const toggleSourceFileVisible = useProjectStore((s) => s.toggleSourceFileVisible);
  const toggleCategoryVisible = useProjectStore((s) => s.toggleCategoryVisible);

  // Track expanded source files in component state — purely view concern.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const toggle = (sfid: number) => {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(sfid)) next.delete(sfid);
      else next.add(sfid);
      return next;
    });
  };

  if (!proj) return null;
  if (proj.source_files.length === 0) {
    return (
      <div className="space-y-3 p-4 text-xs text-[var(--color-ink-faint)]">
        <p>No layers yet.</p>
        <p>
          Head back to <span className="font-medium">Compose</span> in the
          stepper to author an Overpass query, or drop in an existing KML
          file from a previous Overpass Turbo export.
        </p>
      </div>
    );
  }

  return (
    <div className="p-2">
      {proj.source_files.map((sf) => {
        const detail = sourceFiles[sf.id];
        const isExpanded = !collapsed.has(sf.id);
        const isSelectedSource =
          selection.kind === "source" && selection.sourceFileId === sf.id;
        const isHidden = hiddenSourceFiles.has(sf.id);
        return (
          <div key={sf.id} className="mb-2">
            <div
              className={[
                "group flex items-center gap-1.5 rounded-md px-1.5 py-1",
                isSelectedSource
                  ? "bg-[var(--color-accent-soft)]"
                  : "hover:bg-[var(--color-surface-raised)]",
              ].join(" ")}
            >
              <button
                type="button"
                onClick={() => toggle(sf.id)}
                aria-label={isExpanded ? "Collapse" : "Expand"}
                className="w-4 text-xs text-[var(--color-ink-faint)]"
              >
                {isExpanded ? "▾" : "▸"}
              </button>
              <EyeToggle
                hidden={isHidden}
                onClick={() => toggleSourceFileVisible(sf.id)}
                title={isHidden ? "Show this file on the map" : "Hide this file from the map"}
              />
              <button
                type="button"
                onClick={() => setSelection({ kind: "source", sourceFileId: sf.id })}
                className={[
                  "min-w-0 flex-1 truncate text-left text-sm font-medium",
                  isHidden && "opacity-50",
                ].filter(Boolean).join(" ")}
                title={sf.filename}
              >
                <span className="block truncate">{sf.filename}</span>
                {(detail?.category_key ?? sf.category_key) && (
                  <span className="block text-[10px] font-normal text-[var(--color-ink-faint)]">
                    grouped by{" "}
                    <code className="font-[var(--font-mono)]">
                      {detail?.category_key ?? sf.category_key}
                    </code>
                  </span>
                )}
                {sf.truncation && (
                  <TruncationPip truncation={sf.truncation} />
                )}
              </button>
              <span className="text-[10px] text-[var(--color-ink-faint)]">
                {detail?.placemark_count ?? sf.placemark_count}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Remove ${sf.filename} from this project?`)) {
                    deleteSourceFile(sf.id);
                  }
                }}
                className="hidden text-[10px] text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] group-hover:inline"
              >
                ✕
              </button>
            </div>
            {isExpanded && detail && (
              <CategoriesAndPlacemarks
                detail={detail}
                selection={selection}
                onSelect={setSelection}
                hiddenCategories={hiddenCategories}
                onToggleCategory={toggleCategoryVisible}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Truncation pip — small caption rendered under the filename when a
 * SourceFile's ingest hit the synthesizer cap. Hover for the exact
 * counts; the inline text stays short to keep the row from growing. */
function TruncationPip({
  truncation,
}: {
  truncation: NonNullable<
    import("@/lib/types").SourceFileSummary["truncation"]
  >;
}) {
  const { total, ingested, truncated } = truncation;
  return (
    <span
      className="mt-0.5 inline-flex items-center gap-1 rounded-full border border-[var(--color-warning,#b88f49)] px-1.5 py-0 text-[9px] uppercase tracking-[0.16em] text-[var(--color-warning,#b88f49)]"
      title={`Truncated: ${truncated.toLocaleString()} of ${total.toLocaleString()} features dropped (kept ${ingested.toLocaleString()})`}
    >
      <span aria-hidden="true">⚑</span>
      <span>
        truncated · {ingested.toLocaleString()} of {total.toLocaleString()}
      </span>
    </span>
  );
}

function EyeToggle({
  hidden,
  onClick,
  title,
}: {
  hidden: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      aria-label={title}
      className="text-xs text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
    >
      {hidden ? "◌" : "●"}
    </button>
  );
}

function CategoriesAndPlacemarks({
  detail,
  selection,
  onSelect,
  hiddenCategories,
  onToggleCategory,
}: {
  detail: import("@/lib/types").SourceFileDetail;
  selection: ReturnType<typeof useProjectStore.getState>["selection"];
  onSelect: ReturnType<typeof useProjectStore.getState>["setSelection"];
  hiddenCategories: Set<string>;
  onToggleCategory: (value: string) => void;
}) {
  const styleForCategory = useProjectStore((s) => s.styleForCategory);
  const sortedCategories = useMemo(
    () =>
      Object.entries(detail.category_counts).sort(
        ([a], [b]) => a.localeCompare(b),
      ),
    [detail.category_counts],
  );

  if (sortedCategories.length === 0) {
    return (
      <p className="ml-6 mt-1 text-[11px] italic text-[var(--color-ink-faint)]">
        {detail.category_key
          ? `No "${detail.category_key}" values found on these placemarks.`
          : "No category tag detected on these placemarks."}
      </p>
    );
  }

  return (
    <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-[var(--color-line)] pl-2">
      {sortedCategories.map(([value, count]) => {
        const isSelected =
          selection.kind === "category" &&
          selection.sourceFileId === detail.id &&
          selection.categoryValue === value;
        const isHidden = hiddenCategories.has(value);
        const styleRgba = styleForCategory(value) ?? defaultFeatureStyle();
        return (
          <li key={value}>
            <div
              className={[
                "group flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-xs",
                isSelected
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-ink)]"
                  : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-raised)]",
              ].join(" ")}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCategory(value);
                }}
                title={isHidden ? `Show ${value} on the map` : `Hide ${value} from the map`}
                aria-label={isHidden ? `Show ${value}` : `Hide ${value}`}
                className="text-[10px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
              >
                {isHidden ? "◌" : "●"}
              </button>
              <button
                type="button"
                onClick={() =>
                  onSelect({
                    kind: "category",
                    sourceFileId: detail.id,
                    categoryValue: value,
                  })
                }
                className={[
                  "flex min-w-0 flex-1 items-center gap-2 text-left",
                  isHidden && "opacity-50",
                ].filter(Boolean).join(" ")}
              >
                <span
                  className="block h-3 w-3 shrink-0 rounded-sm border"
                  style={{
                    backgroundColor: rgbaToCss(styleRgba.polygon.fill_color),
                    borderColor: rgbaToCss(styleRgba.polygon.outline_color),
                  }}
                />
                <span className="truncate font-[var(--font-mono)] text-[11px]">{value}</span>
                <span className="ml-auto shrink-0 text-[10px] text-[var(--color-ink-faint)]">
                  {count}
                </span>
              </button>
            </div>
            {isSelected && (
              <PlacemarkList
                detail={detail}
                categoryValue={value}
                selection={selection}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Categories with > VIRTUALIZATION_THRESHOLD placemarks get scroll-windowed
// instead of rendering every <li>. With 1000+ placemarks the naïve render
// drops frames on selection changes; below the threshold the list is cheap
// and the simpler DOM is preferable.
const VIRTUALIZATION_THRESHOLD = 200;
// Tailwind ``py-1`` (4px top + 4px bottom) + 16px text line-height ≈ 24px;
// keep this in sync with the className below if either changes.
const ROW_HEIGHT_PX = 24;
// Container height matches the original ``max-h-48`` (12rem ≈ 192px) so the
// virtualized branch occupies the same screen real estate as the simple one.
const LIST_HEIGHT_PX = 192;
const VIRTUAL_OVERSCAN = 6;

function PlacemarkList({
  detail,
  categoryValue,
  selection,
  onSelect,
}: {
  detail: import("@/lib/types").SourceFileDetail;
  categoryValue: string;
  selection: ReturnType<typeof useProjectStore.getState>["selection"];
  onSelect: ReturnType<typeof useProjectStore.getState>["setSelection"];
}) {
  const items = useMemo(
    () => detail.placemarks.filter((p) => p.category_value === categoryValue),
    [detail.placemarks, categoryValue],
  );

  if (items.length > VIRTUALIZATION_THRESHOLD) {
    return (
      <VirtualizedPlacemarkList
        detail={detail}
        items={items}
        selection={selection}
        onSelect={onSelect}
      />
    );
  }

  return (
    <ul className="ml-3 mt-0.5 max-h-48 space-y-0.5 overflow-y-auto border-l border-[var(--color-line)] pl-2">
      {items.map((p) => {
        const isSelected =
          selection.kind === "placemark" &&
          selection.sourceFileId === detail.id &&
          selection.placemarkIndex === p.index;
        const labelBits = [
          p.name,
          p.extended_data["name:fr"],
          p.extended_data["name:en"],
          `#${p.index}`,
        ].filter(Boolean);
        const label = labelBits[0] ?? `#${p.index}`;
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
                  className="text-[10px] text-[var(--color-accent)]"
                >
                  ⚑
                </span>
              )}
              {Object.keys(p.annotations).length > 0 && (
                <span
                  title="Has annotations"
                  className="text-[10px] text-[var(--color-success)]"
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

/** Hand-rolled scroll windowing for very long placemark lists. We compute
 *  ``startIdx`` from ``scrollTop / ROW_HEIGHT_PX`` plus a small overscan,
 *  then render only the visible slice inside a spacer-padded container.
 *  This avoids pulling in a virtualization dependency for the one case
 *  that actually needs it. */
function VirtualizedPlacemarkList({
  detail,
  items,
  selection,
  onSelect,
}: {
  detail: import("@/lib/types").SourceFileDetail;
  items: import("@/lib/types").PlacemarkPreview[];
  selection: ReturnType<typeof useProjectStore.getState>["selection"];
  onSelect: ReturnType<typeof useProjectStore.getState>["setSelection"];
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const totalHeight = items.length * ROW_HEIGHT_PX;
  const visibleCount = Math.ceil(LIST_HEIGHT_PX / ROW_HEIGHT_PX);
  const startIdx = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT_PX) - VIRTUAL_OVERSCAN,
  );
  const endIdx = Math.min(
    items.length,
    startIdx + visibleCount + VIRTUAL_OVERSCAN * 2,
  );
  const visible = items.slice(startIdx, endIdx);
  const offsetY = startIdx * ROW_HEIGHT_PX;

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      className="ml-3 mt-0.5 overflow-y-auto border-l border-[var(--color-line)] pl-2"
      style={{ height: LIST_HEIGHT_PX }}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <ul
          className="space-y-0.5"
          style={{ position: "absolute", top: offsetY, left: 0, right: 0 }}
        >
          {visible.map((p) => {
            const isSelected =
              selection.kind === "placemark" &&
              selection.sourceFileId === detail.id &&
              selection.placemarkIndex === p.index;
            const labelBits = [
              p.name,
              p.extended_data["name:fr"],
              p.extended_data["name:en"],
              `#${p.index}`,
            ].filter(Boolean);
            const label = labelBits[0] ?? `#${p.index}`;
            return (
              <li key={p.index} style={{ height: ROW_HEIGHT_PX }}>
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
                      className="text-[10px] text-[var(--color-accent)]"
                    >
                      ⚑
                    </span>
                  )}
                  {Object.keys(p.annotations).length > 0 && (
                    <span
                      title="Has annotations"
                      className="text-[10px] text-[var(--color-success)]"
                    >
                      ✎
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
