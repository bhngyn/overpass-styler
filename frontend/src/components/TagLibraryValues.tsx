/**
 * TagLibraryValues — middle column of the Tag Library drawer.
 *
 * Three modes, switched by the parent through props:
 *
 *  1. **Search mode** (``searchQ`` set) — renders merged search hits from
 *     ``/api/tag-library/search``. Curated hits surface first (the backend
 *     pre-boosts them), then Taginfo by-keyword results.
 *  2. **Key mode** (``selectedKey`` set, no search) — renders the top values
 *     for that key, sorted by global usage. Each row carries a one-line
 *     description from Taginfo's ``key/values`` payload.
 *  3. **Empty mode** — a calm placeholder telling investigators what to do.
 *
 * Selection is parent-owned. We just emit a ``(key, value)`` pair when a row
 * is clicked.
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type {
  SearchHit,
  TaginfoValue,
} from "@/lib/tagLibrary.types";

export interface TagLibraryValuesProps {
  /** When set, the column shows ``key``'s values. */
  selectedKey: string | null;
  /** When set (truthy), the column shows search results instead. */
  searchQ: string | null;
  /** Currently-selected value (highlighted). */
  selectedValue: string | null;
  /** Clicked through to a concrete ``key=value``. */
  onSelectValue: (key: string, value: string) => void;
  /** Network calls (values, search) need the session confirmation. */
  requireConfirmation: () => Promise<boolean>;
}

interface ValuesState {
  loading: boolean;
  data: TaginfoValue[];
  error: string | null;
  /** The key these values belong to — guards against stale responses. */
  forKey: string | null;
}

interface SearchState {
  loading: boolean;
  hits: SearchHit[];
  error: string | null;
  /** The query string these hits belong to — guards stale responses. */
  forQ: string | null;
}

export function TagLibraryValues({
  selectedKey,
  searchQ,
  selectedValue,
  onSelectValue,
  requireConfirmation,
}: TagLibraryValuesProps) {
  const [values, setValues] = useState<ValuesState>({
    loading: false,
    data: [],
    error: null,
    forKey: null,
  });
  const [search, setSearch] = useState<SearchState>({
    loading: false,
    hits: [],
    error: null,
    forQ: null,
  });

  // Values fetch — only when not in search mode and a key is selected.
  useEffect(() => {
    if (searchQ) return; // search overrides
    if (!selectedKey) {
      setValues({ loading: false, data: [], error: null, forKey: null });
      return;
    }
    if (values.forKey === selectedKey && !values.loading) return;

    let cancelled = false;
    (async () => {
      const ok = await requireConfirmation();
      if (!ok || cancelled) return;
      setValues({ loading: true, data: [], error: null, forKey: selectedKey });
      try {
        const resp = await api.tagLibrary.values(selectedKey);
        if (cancelled) return;
        setValues({
          loading: false,
          data: resp.data,
          error: null,
          forKey: selectedKey,
        });
      } catch (err) {
        if (cancelled) return;
        setValues({
          loading: false,
          data: [],
          error: err instanceof Error ? err.message : "Failed to load values",
          forKey: selectedKey,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, searchQ]);

  // Search fetch — debounced by parent already; we still guard against stale
  // responses with the ``forQ`` check.
  useEffect(() => {
    if (!searchQ) {
      setSearch({ loading: false, hits: [], error: null, forQ: null });
      return;
    }
    if (search.forQ === searchQ && !search.loading) return;

    let cancelled = false;
    (async () => {
      const ok = await requireConfirmation();
      if (!ok || cancelled) return;
      setSearch({ loading: true, hits: [], error: null, forQ: searchQ });
      try {
        const resp = await api.tagLibrary.search(searchQ);
        if (cancelled) return;
        setSearch({
          loading: false,
          hits: resp.hits,
          error: null,
          forQ: searchQ,
        });
      } catch (err) {
        if (cancelled) return;
        setSearch({
          loading: false,
          hits: [],
          error: err instanceof Error ? err.message : "Search failed",
          forQ: searchQ,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQ]);

  // Render — search takes precedence.
  if (searchQ) {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-[var(--color-line)] px-3 py-2">
          <h3 className="font-[var(--font-display)] text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-ink-soft)]">
            Results for <span className="text-[var(--color-ink)]">"{searchQ}"</span>
          </h3>
        </header>
        <div className="flex-1 overflow-y-auto">
          {search.loading && (
            <p className="px-3 py-3 text-xs text-[var(--color-ink-faint)]">Searching…</p>
          )}
          {!search.loading && search.error && (
            <p className="px-3 py-3 text-xs text-[var(--color-danger)]">{search.error}</p>
          )}
          {!search.loading && !search.error && search.hits.length === 0 && (
            <p className="px-3 py-3 text-xs text-[var(--color-ink-faint)]">No matches.</p>
          )}
          {!search.loading && !search.error && search.hits.length > 0 && (
            <ul className="divide-y divide-[var(--color-line)]">
              {search.hits.map((hit, i) => (
                <SearchRow
                  key={`${hit.source}-${hit.key}-${hit.value ?? ""}-${i}`}
                  hit={hit}
                  isActive={
                    hit.value != null &&
                    hit.key === selectedKey &&
                    hit.value === selectedValue
                  }
                  onClick={() => {
                    if (hit.value) onSelectValue(hit.key, hit.value);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  // Key mode.
  if (selectedKey) {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-[var(--color-line)] px-3 py-2">
          <h3 className="font-[var(--font-display)] text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-ink-soft)]">
            Values for <code className="font-[var(--font-mono)] text-xs text-[var(--color-ink)]">{selectedKey}</code>
          </h3>
        </header>
        <div className="flex-1 overflow-y-auto">
          {values.loading && (
            <p className="px-3 py-3 text-xs text-[var(--color-ink-faint)]">Loading…</p>
          )}
          {!values.loading && values.error && (
            <p className="px-3 py-3 text-xs text-[var(--color-danger)]">{values.error}</p>
          )}
          {!values.loading && !values.error && values.data.length === 0 && (
            <p className="px-3 py-3 text-xs text-[var(--color-ink-faint)]">
              No values returned.
            </p>
          )}
          {!values.loading && !values.error && values.data.length > 0 && (
            <ul className="divide-y divide-[var(--color-line)]">
              {values.data.map((row) => {
                const isActive = row.value === selectedValue;
                return (
                  <li key={row.value}>
                    <button
                      type="button"
                      onClick={() => onSelectValue(selectedKey, row.value)}
                      className={[
                        "block w-full px-3 py-2 text-left transition-colors",
                        isActive
                          ? "bg-[var(--color-accent-soft)]"
                          : "hover:bg-[var(--color-surface-sunken)]",
                      ].join(" ")}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <code className="truncate font-[var(--font-mono)] text-sm text-[var(--color-ink)]">
                          {row.value}
                        </code>
                        <span className="shrink-0 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
                          {formatCount(row.count)}
                        </span>
                      </div>
                      {row.description && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-[var(--color-ink-soft)]">
                          {row.description}
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  }

  // Empty state — point the investigator at the left column.
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <p className="font-[var(--font-display)] text-sm italic text-[var(--color-ink-faint)]">
        Pick a curated entry or an OSM key to see its values here.
      </p>
    </div>
  );
}

interface SearchRowProps {
  hit: SearchHit;
  isActive: boolean;
  onClick: () => void;
}

function SearchRow({ hit, isActive, onClick }: SearchRowProps) {
  const isCurated = hit.source === "curated";
  const tagLabel = hit.value ? `${hit.key}=${hit.value}` : `${hit.key}=*`;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={!hit.value}
        className={[
          "block w-full px-3 py-2 text-left transition-colors",
          isActive
            ? "bg-[var(--color-accent-soft)]"
            : "hover:bg-[var(--color-surface-sunken)]",
          !hit.value && "cursor-not-allowed opacity-60",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-[var(--color-ink)]">
            {hit.label ?? tagLabel}
          </span>
          {isCurated && (
            <span className="shrink-0 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-[var(--color-accent)]">
              curated
            </span>
          )}
        </div>
        <code className="mt-0.5 block truncate font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
          {tagLabel}
        </code>
        {isCurated && hit.curated?.field_note && (
          <p className="mt-1 line-clamp-2 text-xs text-[var(--color-ink-soft)]">
            {hit.curated.field_note}
          </p>
        )}
      </button>
    </li>
  );
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
