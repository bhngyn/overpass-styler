/**
 * TagLibraryValues — middle column of the Tag Library drawer.
 *
 * Despite the historical name, this column is no longer a per-key "values"
 * drill-in. It's the flat, paginated, popularity-sorted browser over the
 * full bundled OSM tag index (~21k ``key=value`` pairs) and doubles as
 * the live search-results surface. The drawer's header search bar drives
 * a ``filterQuery`` prop here; an empty query shows every tag in the
 * index, popularity-first.
 *
 * Why this lives where the per-key values column used to live: in practice
 * almost every tag the investigator wants is already a fully-formed
 * ``key=value`` pair (``amenity=prison``, ``building=detention``, …). The
 * old two-step "pick a key → see its values" path added clicks without
 * adding information, and tag-detail (the right column) needs both halves
 * of the pair anyway. The middle column is now the source of truth for
 * browsing.
 *
 * Pagination: the list initially shows the first 500 rows. When the
 * operator scrolls within ~200px of the bottom of the loaded window, the
 * next 500 rows are appended. A footer banner ("Showing N of M") makes
 * progress visible. Counts reset to the first 500 whenever the filter
 * changes so the operator always lands at the top of fresh results.
 *
 * Rendering is virtualized so the DOM stays small even if the operator
 * scrolls to the end of the 21k-row list.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterOsmTags,
  TAGINFO_INDEX_BY_COUNT,
} from "@/lib/osmTagSearch";
import type { TaginfoIndexEntry } from "@/lib/taginfoIndex";

export interface TagLibraryValuesProps {
  /** Free-text filter query lifted from the drawer header. Empty string
   *  means "show everything by popularity". */
  filterQuery: string;
  /** Highlighted key (matches against the row's ``key``). */
  selectedKey: string | null;
  /** Highlighted value (combined with ``selectedKey`` to identify the
   *  active row). */
  selectedValue: string | null;
  /** Click handler — emits a fully-formed ``key=value`` pair. The drawer
   *  drives the right-column detail panel off this selection. */
  onSelectTag: (key: string, value: string) => void;
}

const PAGE_SIZE = 500;
const ROW_HEIGHT_PX = 36;
const OVERSCAN_ROWS = 8;
// Auto-load the next page when the scroll position gets within this many
// pixels of the bottom of the currently-loaded slice.
const LOAD_MORE_PX = 200;

export function TagLibraryValues({
  filterQuery,
  selectedKey,
  selectedValue,
  onSelectTag,
}: TagLibraryValuesProps) {
  // Re-rank the bundled index on every keystroke. The full sort+filter
  // pass over 21k rows is sub-10ms — no debouncing needed.
  const filtered = useMemo<readonly TaginfoIndexEntry[]>(
    () => filterOsmTags(filterQuery, TAGINFO_INDEX_BY_COUNT.length),
    [filterQuery],
  );

  // Pagination — how many of the filtered results are currently "loaded"
  // (rendered + counted in the footer). Starts at 1 page (500 rows) and
  // grows in 500-row increments as the operator scrolls toward the end.
  const [loadedRows, setLoadedRows] = useState(PAGE_SIZE);

  // Reset to page 1 whenever the filter changes — the operator always
  // wants to land at the top of fresh results, not 6 pages deep into
  // stale ones.
  useEffect(() => {
    setLoadedRows(PAGE_SIZE);
    listRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery]);

  // Visible slice — the actual data to render. Capped at ``loadedRows``
  // so the operator only sees what pagination has revealed.
  const visible = useMemo(
    () => filtered.slice(0, loadedRows),
    [filtered, loadedRows],
  );
  const hasMore = visible.length < filtered.length;

  // Scroll windowing inside the loaded slice — the DOM never holds more
  // than ~30 rows even when 21k are "loaded", so scrolling stays smooth.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(360);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalH = visible.length * ROW_HEIGHT_PX;
  const visibleCount = Math.ceil(viewportH / ROW_HEIGHT_PX);
  const startIdx = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT_PX) - OVERSCAN_ROWS,
  );
  const endIdx = Math.min(
    visible.length,
    startIdx + visibleCount + OVERSCAN_ROWS * 2,
  );
  const offsetY = startIdx * ROW_HEIGHT_PX;

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const target = e.target as HTMLDivElement;
    setScrollTop(target.scrollTop);
    // Bottom edge — measured as distance from the bottom of the slice's
    // virtual height to the current scroll position + viewport. Once it
    // drops under LOAD_MORE_PX we pull the next page in.
    const distanceFromBottom =
      totalH - (target.scrollTop + target.clientHeight);
    if (hasMore && distanceFromBottom < LOAD_MORE_PX) {
      setLoadedRows((n) => Math.min(n + PAGE_SIZE, filtered.length));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-[var(--color-line)] px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-[var(--font-display)] text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-ink-soft)]">
            {filterQuery ? "Search results" : "All OSM tags"}
          </h3>
          <span
            className="font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]"
            title={`Showing ${visible.length.toLocaleString()} of ${filtered.length.toLocaleString()} matching · ${TAGINFO_INDEX_BY_COUNT.length.toLocaleString()} in index`}
          >
            {filterQuery
              ? `${filtered.length.toLocaleString()} match${filtered.length === 1 ? "" : "es"}`
              : `${TAGINFO_INDEX_BY_COUNT.length.toLocaleString()} total`}
          </span>
        </div>
        <p className="mt-0.5 text-[10px] text-[var(--color-ink-faint)]">
          {filterQuery
            ? "Live filter over the bundled offline index, ranked by popularity."
            : "Bundled offline index, sorted by global OSM usage count."}
        </p>
      </header>

      {filtered.length === 0 ? (
        <div className="flex h-full items-center justify-center px-4 text-center">
          <p className="text-xs text-[var(--color-ink-faint)]">
            No matches in the bundled index for{" "}
            <code className="font-[var(--font-mono)]">
              {`"${filterQuery}"`}
            </code>
            .
          </p>
        </div>
      ) : (
        <div
          ref={listRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div style={{ height: totalH, position: "relative" }}>
            <ul
              className="absolute inset-x-0 m-0 p-0"
              style={{ top: offsetY }}
            >
              {visible.slice(startIdx, endIdx).map((entry) => {
                const isActive =
                  entry.key === selectedKey && entry.value === selectedValue;
                return (
                  <li
                    key={`${entry.key}=${entry.value}`}
                    style={{ height: ROW_HEIGHT_PX }}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectTag(entry.key, entry.value)}
                      className={[
                        "flex h-full w-full items-baseline justify-between gap-2 px-3 text-left",
                        isActive
                          ? "bg-[var(--color-accent-soft)] text-[var(--color-ink)]"
                          : "hover:bg-[var(--color-surface-sunken)]",
                      ].join(" ")}
                      title={`${entry.key}=${entry.value} — ${entry.count.toLocaleString()} uses`}
                    >
                      <code className="truncate font-[var(--font-mono)] text-xs text-[var(--color-ink)]">
                        <span className="text-[var(--color-ink-faint)]">
                          {entry.key}
                        </span>
                        =
                        <span>{entry.value}</span>
                      </code>
                      <span className="shrink-0 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
                        {formatCount(entry.count)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <footer className="shrink-0 border-t border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-3 py-1.5">
          <p className="text-[10px] text-[var(--color-ink-faint)]">
            Showing{" "}
            <span className="font-[var(--font-mono)] text-[var(--color-ink-soft)]">
              {visible.length.toLocaleString()}
            </span>{" "}
            of{" "}
            <span className="font-[var(--font-mono)] text-[var(--color-ink-soft)]">
              {filtered.length.toLocaleString()}
            </span>
            {hasMore ? " · scroll for more" : " · end of list"}
          </p>
        </footer>
      )}
    </div>
  );
}

/** Compact count formatting — 12,403 → "12k", 1,243,500 → "1.2M". */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
