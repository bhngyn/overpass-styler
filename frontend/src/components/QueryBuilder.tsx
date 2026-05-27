/**
 * QueryBuilder — investigator-facing surface for selecting "kinds of place".
 *
 * Replaces the raw Overpass QL textarea in the Compose step. The
 * investigator never sees OSM tags by default: they pick subjects
 * (Prisons & detention, Hospitals & clinics, …) and the QL is emitted
 * downstream from the resolved subject set.
 *
 * Selection lives on the QueryDraft; this component is pure with respect
 * to it — parent owns ``selectedSubjectIds`` and the curated glossary.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SubjectChip } from "@/components/SubjectChip";
import { SubjectPicker } from "@/components/SubjectPicker";
import {
  SEED_SCENARIOS,
  SUBJECT_CATALOG,
  searchSubjects,
  type SubjectSearchHit,
} from "@/lib/subjectCatalog";
import type { GlossaryEntry } from "@/lib/tagLibrary.types";

interface Props {
  selectedSubjectIds: string[];
  onChange: (next: string[]) => void;
  glossaryEntries: GlossaryEntry[];
  glossaryLoading: boolean;
  glossaryError: string | null;
  onOpenTagLibrary?: () => void;
}

const MAX_INLINE_HITS = 6;

export function QueryBuilder({
  selectedSubjectIds,
  onChange,
  glossaryEntries,
  glossaryLoading,
  glossaryError,
  onOpenTagLibrary,
}: Props) {
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const searchWrapRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown when focus / clicks land outside the search wrapper.
  // Listening on mousedown avoids the focus-vs-click ordering quirk that would
  // otherwise hide the dropdown before the click on a hit registered.
  useEffect(() => {
    function onPointer(e: MouseEvent) {
      const root = searchWrapRef.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      setSearchFocused(false);
    }
    document.addEventListener("mousedown", onPointer, true);
    return () => document.removeEventListener("mousedown", onPointer, true);
  }, []);

  const trimmed = search.trim();
  const selectedSet = useMemo(() => new Set(selectedSubjectIds), [selectedSubjectIds]);

  const hits = useMemo<SubjectSearchHit[]>(
    () =>
      trimmed
        ? searchSubjects(trimmed, glossaryEntries, SUBJECT_CATALOG, MAX_INLINE_HITS)
        : [],
    [trimmed, glossaryEntries],
  );

  const selectedSubjects = useMemo(
    () =>
      selectedSubjectIds
        .map((id) => SUBJECT_CATALOG.find((s) => s.id === id))
        .filter((s): s is (typeof SUBJECT_CATALOG)[number] => s !== undefined),
    [selectedSubjectIds],
  );

  function addSubject(id: string) {
    if (selectedSet.has(id)) return;
    onChange([...selectedSubjectIds, id]);
  }

  function removeSubject(id: string) {
    onChange(selectedSubjectIds.filter((s) => s !== id));
  }

  function toggleSubject(id: string) {
    if (selectedSet.has(id)) removeSubject(id);
    else addSubject(id);
  }

  function applySeed(ids: string[]) {
    onChange(ids);
  }

  function pickHit(hit: SubjectSearchHit) {
    addSubject(hit.subject.id);
    setSearch("");
    setSearchFocused(false);
  }

  const showDropdown = (searchFocused || trimmed.length > 0) && hits.length > 0;
  const hasSelection = selectedSubjects.length > 0;

  return (
    <div className="space-y-4">
      <p
        className="uppercase text-[var(--color-ink-faint)]"
        style={{ fontSize: "10px", letterSpacing: "0.22em", fontWeight: 600 }}
      >
        What to find
      </p>

      <div ref={searchWrapRef} className="relative">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          onFocus={() => setSearchFocused(true)}
          placeholder="Search subjects: prisons, hospitals, churches…"
          className={[
            "w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)]",
            "px-3 py-1.5 text-sm text-[var(--color-ink)]",
            "placeholder:text-[var(--color-ink-faint)]",
            "focus:border-[var(--color-accent)] focus:outline-none",
          ].join(" ")}
          aria-label="Search subjects"
          aria-autocomplete="list"
          aria-expanded={showDropdown}
        />
        {showDropdown && (
          <ul
            role="listbox"
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] shadow-[0_8px_24px_-8px_rgba(26,23,20,0.25)]"
          >
            {hits.map((hit) => {
              const already = selectedSet.has(hit.subject.id);
              return (
                <li key={hit.subject.id} role="option" aria-selected={already}>
                  <button
                    type="button"
                    onClick={() => pickHit(hit)}
                    disabled={already}
                    className={[
                      "flex w-full items-center gap-2 px-3 py-2 text-left",
                      already
                        ? "cursor-not-allowed opacity-60"
                        : "hover:bg-[var(--color-surface-sunken)] focus:bg-[var(--color-surface-sunken)] focus:outline-none",
                    ].join(" ")}
                  >
                    <span aria-hidden className="text-base leading-none">
                      {hit.subject.icon}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-[var(--color-ink)]">
                        {hit.subject.label}
                      </span>
                      <span className="truncate text-[11px] text-[var(--color-ink-faint)]">
                        {hit.matchedField === "tag" ? (
                          <span className="font-[var(--font-mono)]">
                            {hit.matchedText}
                          </span>
                        ) : (
                          <span style={{ fontWeight: 600 }}>{hit.matchedText}</span>
                        )}
                      </span>
                    </span>
                    {already && (
                      <span className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
                        Added
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {glossaryError && (
        <div
          role="alert"
          className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-3 py-2 text-[12px] text-[var(--color-danger)]"
        >
          Couldn't load subject details: {glossaryError}
        </div>
      )}

      {hasSelection && (
        <div className="space-y-1.5">
          {selectedSubjects.map((subject) => (
            <SubjectChip
              key={subject.id}
              subject={subject}
              glossaryEntries={glossaryEntries}
              onRemove={() => removeSubject(subject.id)}
            />
          ))}
        </div>
      )}

      {!hasSelection && glossaryLoading && (
        <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-3 py-6 text-center">
          <p className="text-[12px] italic text-[var(--color-ink-faint)]">
            Loading subjects…
          </p>
        </div>
      )}

      {!hasSelection && !glossaryLoading && (
        <div className="space-y-3">
          <p className="text-[12px] text-[var(--color-ink-soft)]">
            Or start from a common investigation:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {SEED_SCENARIOS.map((scenario) => (
              <button
                key={scenario.id}
                type="button"
                onClick={() => applySeed(scenario.subjectIds)}
                title={scenario.description}
                className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[12px] text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
              >
                {scenario.label}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPickerOpen(true)}
          >
            Browse all categories <span aria-hidden>→</span>
          </Button>
        </div>
      )}

      {hasSelection && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setPickerOpen(true)}
        >
          + Add another kind of place
        </Button>
      )}

      <SubjectPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        glossaryEntries={glossaryEntries}
        selectedIds={selectedSubjectIds}
        onToggle={toggleSubject}
        onOpenTagLibrary={onOpenTagLibrary}
      />

      {/* TODO: Advanced disclosure (raw-QL escape hatch) deferred to a future iteration. */}
    </div>
  );
}
