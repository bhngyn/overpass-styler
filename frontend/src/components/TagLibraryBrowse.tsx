/**
 * TagLibraryBrowse — left column of the Tag Library drawer.
 *
 * Now scoped to the curated atrocity-investigation glossary only. The
 * "All OSM tags" flat browser used to live below this section but moved
 * to the middle column (``TagLibraryValues``) where it gets more screen
 * real estate and behaves as the home for both browsing and search
 * results.
 *
 * The component owns no selection state; the drawer parent coordinates
 * the three columns.
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type {
  GlossaryDomain,
  GlossaryEntry,
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
  /** Highlighted curated entry, when the user has clicked a curated row. */
  selectedCuratedId: string | null;
  /** Click handler: a curated entry (jumps to Detail). */
  onSelectCurated: (entry: GlossaryEntry) => void;
}

interface BrowseState {
  loading: boolean;
  curated: GlossaryEntry[];
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
  selectedCuratedId,
  onSelectCurated,
}: TagLibraryBrowseProps) {
  const [state, setState] = useState<BrowseState>({
    loading: true,
    curated: [],
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

  const grouped = groupCurated(state.curated);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <section className="px-3 py-3">
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
    </div>
  );
}
