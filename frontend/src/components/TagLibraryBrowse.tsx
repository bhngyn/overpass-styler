/**
 * TagLibraryBrowse — left column of the Tag Library drawer.
 *
 * Two stacked sections, both loaded once on mount:
 *
 *  1. **Curated for atrocity investigations** — entries from the offline
 *     glossary in ``backend/app/kml/tag_glossary.py``, grouped by domain.
 *     Clicking a row jumps straight to the Detail column (skipping the
 *     Values middle column) because curated entries already carry a
 *     concrete ``key=value`` pair.
 *  2. **All OSM keys** — Taginfo's top OSM keys, sorted by global usage
 *     count desc. Clicking a key routes to the Values column.
 *
 * The component is intentionally dumb: it owns no selection state. Selection
 * lives in the drawer parent so the three columns stay synced.
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type {
  GlossaryDomain,
  GlossaryEntry,
  TaginfoKey,
} from "@/lib/tagLibrary.types";

// Human-readable domain labels for the curated section's group headers.
// Order here drives the rail's section order.
const DOMAIN_ORDER: Array<{ id: GlossaryDomain; label: string }> = [
  { id: "detention", label: "Detention" },
  { id: "mortality", label: "Mortality" },
  { id: "destruction", label: "Destruction" },
  { id: "military", label: "Military" },
  { id: "displacement", label: "Displacement" },
  { id: "civilian", label: "Civilian infrastructure" },
  { id: "evidence", label: "Evidence" },
];

export interface TagLibraryBrowseProps {
  /** Highlighted key, when the user has clicked into Values. */
  selectedKey: string | null;
  /** Highlighted curated entry, when the user has clicked a curated row. */
  selectedCuratedId: string | null;
  /** Click handler: a curated entry (jumps to Detail). */
  onSelectCurated: (entry: GlossaryEntry) => void;
  /** Click handler: a bare OSM key (populates Values). */
  onSelectKey: (key: string) => void;
  /**
   * Triggered when an outbound Taginfo call is about to fire for the first
   * time this session. The drawer parent owns the confirm modal; we just
   * report intent and wait for the parent to greenlight via ``approved``.
   */
  requireConfirmation: () => Promise<boolean>;
}

interface BrowseState {
  loading: boolean;
  curated: GlossaryEntry[];
  keys: TaginfoKey[];
  keysError: string | null;
  keysLoaded: boolean;
}

function groupCurated(entries: GlossaryEntry[]): Map<GlossaryDomain, GlossaryEntry[]> {
  const byDomain = new Map<GlossaryDomain, GlossaryEntry[]>();
  for (const entry of entries) {
    const bucket = byDomain.get(entry.domain) ?? [];
    bucket.push(entry);
    byDomain.set(entry.domain, bucket);
  }
  return byDomain;
}

export function TagLibraryBrowse({
  selectedKey,
  selectedCuratedId,
  onSelectCurated,
  onSelectKey,
  requireConfirmation,
}: TagLibraryBrowseProps) {
  const [state, setState] = useState<BrowseState>({
    loading: true,
    curated: [],
    keys: [],
    keysError: null,
    keysLoaded: false,
  });

  // Curated is offline — fetch on mount, no confirmation needed.
  useEffect(() => {
    let cancelled = false;
    api.tagLibrary
      .curated()
      .then((resp) => {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false, curated: resp.entries }));
      })
      .catch(() => {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keys load lazily — the first interaction (drawer open) is fine to fire
  // the request, but it's a Taginfo (outbound) call. Gate behind the
  // session confirmation modal.
  const loadKeys = async () => {
    if (state.keysLoaded || state.loading) return;
    const ok = await requireConfirmation();
    if (!ok) return;
    try {
      const resp = await api.tagLibrary.keys();
      setState((s) => ({
        ...s,
        keys: resp.data,
        keysLoaded: true,
        keysError: null,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        keysError: err instanceof Error ? err.message : "Failed to load keys",
        keysLoaded: true,
      }));
    }
  };

  const grouped = groupCurated(state.curated);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Curated section */}
      <section className="border-b border-[var(--color-line)] px-3 py-3">
        <h3 className="mb-2 font-[var(--font-display)] text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-ink-soft)]">
          Curated for investigations
        </h3>
        {state.loading ? (
          <p className="text-xs text-[var(--color-ink-faint)]">Loading…</p>
        ) : state.curated.length === 0 ? (
          <p className="text-xs text-[var(--color-ink-faint)]">
            Glossary unavailable.
          </p>
        ) : (
          <div className="space-y-3">
            {DOMAIN_ORDER.map(({ id, label }) => {
              const entries = grouped.get(id);
              if (!entries || entries.length === 0) return null;
              return (
                <div key={id}>
                  <h4 className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--color-ink-faint)]">
                    {label}
                  </h4>
                  <ul className="space-y-0.5">
                    {entries.map((entry) => {
                      const isActive = entry.id === selectedCuratedId;
                      return (
                        <li key={entry.id}>
                          <button
                            type="button"
                            onClick={() => onSelectCurated(entry)}
                            className={[
                              "block w-full rounded px-2 py-1.5 text-left transition-colors",
                              isActive
                                ? "bg-[var(--color-accent-soft)] text-[var(--color-ink)]"
                                : "hover:bg-[var(--color-surface-sunken)]",
                            ].join(" ")}
                          >
                            <span className="block text-sm text-[var(--color-ink)]">
                              {entry.label}
                            </span>
                            <span className="block truncate font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
                              {entry.value
                                ? `${entry.key}=${entry.value}`
                                : `${entry.key}=*`}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* All OSM keys */}
      <section className="px-3 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-[var(--font-display)] text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-ink-soft)]">
            All OSM keys
          </h3>
          {!state.keysLoaded && (
            <button
              type="button"
              onClick={loadKeys}
              className="text-[10px] uppercase tracking-wider text-[var(--color-accent)] hover:underline"
            >
              load from taginfo
            </button>
          )}
        </div>
        {!state.keysLoaded ? (
          <p className="text-xs text-[var(--color-ink-faint)]">
            Click <em>load from taginfo</em> to fetch the top OSM keys.
          </p>
        ) : state.keysError ? (
          <p className="text-xs text-[var(--color-danger)]">{state.keysError}</p>
        ) : state.keys.length === 0 ? (
          <p className="text-xs text-[var(--color-ink-faint)]">No keys returned.</p>
        ) : (
          <ul className="space-y-0.5">
            {state.keys.slice(0, 60).map((row) => {
              const isActive = row.key === selectedKey;
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    onClick={() => onSelectKey(row.key)}
                    className={[
                      "flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left transition-colors",
                      isActive
                        ? "bg-[var(--color-accent-soft)] text-[var(--color-ink)]"
                        : "hover:bg-[var(--color-surface-sunken)]",
                    ].join(" ")}
                  >
                    <code className="truncate font-[var(--font-mono)] text-xs text-[var(--color-ink)]">
                      {row.key}
                    </code>
                    <span className="shrink-0 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
                      {formatCount(row.count_all)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Compact count formatting — 12,403 → "12k", 1,243,500 → "1.2M". */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
