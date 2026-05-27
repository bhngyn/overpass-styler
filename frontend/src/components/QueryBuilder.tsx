/**
 * QueryBuilder — investigator-facing surface for selecting "kinds of place".
 *
 * Replaces the raw Overpass QL textarea in the Compose step. The
 * investigator never sees OSM tags by default: they pick subjects
 * (Prisons & detention, Hospitals & clinics, …) and the QL is emitted
 * downstream from the resolved subject set.
 *
 * Selections come in two flavours: curated subjects (the catalog) and
 * custom OSM tags picked from the broader Taginfo search inside the
 * SubjectPicker. Both render as chips here; both emit blocks at QL
 * generation time. The "Generated query" disclosure surfaces the live
 * Overpass QL for transparency + learning — collapsed by default so a
 * non-technical investigator never has to look at it, expandable when
 * they want to.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SubjectChip } from "@/components/SubjectChip";
import { CustomTagChip } from "@/components/CustomTagChip";
import { SubjectPicker } from "@/components/SubjectPicker";
import {
  SEED_SCENARIOS,
  SUBJECT_CATALOG,
  searchSubjects,
  type SubjectSearchHit,
} from "@/lib/subjectCatalog";
import { buildQuery, customTagsToBlocks, toQL, type CustomTag } from "@/lib/queryBuilder";
import { searchOsmTags, type OsmTagHit } from "@/lib/osmTagSearch";
import type { GlossaryEntry } from "@/lib/tagLibrary.types";

interface Props {
  selectedSubjectIds: string[];
  onChangeSubjectIds: (next: string[]) => void;
  customTags: CustomTag[];
  onChangeCustomTags: (next: CustomTag[]) => void;
  glossaryEntries: GlossaryEntry[];
  glossaryLoading: boolean;
  glossaryError: string | null;
}

const MAX_INLINE_HITS = 6;

export function QueryBuilder({
  selectedSubjectIds,
  onChangeSubjectIds,
  customTags,
  onChangeCustomTags,
  glossaryEntries,
  glossaryLoading,
  glossaryError,
}: Props) {
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showGeneratedQL, setShowGeneratedQL] = useState(false);

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
  const customTagKeySet = useMemo(
    () => new Set(customTags.map(tagKey)),
    [customTags],
  );

  const curatedHits = useMemo<SubjectSearchHit[]>(
    () =>
      trimmed
        ? searchSubjects(trimmed, glossaryEntries, SUBJECT_CATALOG, MAX_INLINE_HITS)
        : [],
    [trimmed, glossaryEntries],
  );

  // OSM tag hits from the offline bundled index. The single inline search is
  // the only place the investigator searches — no separate modal search —
  // so this dropdown carries the full surface. Drop curated tag pairs to
  // avoid double-rendering things already in the HR-curated section.
  const osmHits = useMemo<OsmTagHit[]>(() => {
    if (!trimmed) return [];
    const curatedTagKeys = new Set(
      glossaryEntries
        .filter((e) => e.value !== null)
        .map((e) => `${e.key}=${e.value}`),
    );
    return searchOsmTags(trimmed, MAX_INLINE_HITS * 2).filter(
      (h) => !curatedTagKeys.has(`${h.entry.key}=${h.entry.value}`),
    );
  }, [trimmed, glossaryEntries]);

  const selectedSubjects = useMemo(
    () =>
      selectedSubjectIds
        .map((id) => SUBJECT_CATALOG.find((s) => s.id === id))
        .filter((s): s is (typeof SUBJECT_CATALOG)[number] => s !== undefined),
    [selectedSubjectIds],
  );

  const hasSelection = selectedSubjects.length > 0 || customTags.length > 0;

  const generatedQL = useMemo(
    () =>
      toQL(
        buildQuery({
          subjectIds: selectedSubjectIds,
          customBlocks: customTagsToBlocks(customTags),
          glossary: glossaryEntries,
        }),
      ),
    [selectedSubjectIds, customTags, glossaryEntries],
  );

  function addSubject(id: string) {
    if (selectedSet.has(id)) return;
    onChangeSubjectIds([...selectedSubjectIds, id]);
  }

  function removeSubject(id: string) {
    onChangeSubjectIds(selectedSubjectIds.filter((s) => s !== id));
  }

  function toggleSubject(id: string) {
    if (selectedSet.has(id)) removeSubject(id);
    else addSubject(id);
  }

  function toggleCustomTag(key: string, value: string | null) {
    const tag: CustomTag = { key, value };
    const tk = tagKey(tag);
    if (customTagKeySet.has(tk)) {
      onChangeCustomTags(customTags.filter((t) => tagKey(t) !== tk));
    } else {
      onChangeCustomTags([...customTags, tag]);
    }
  }

  function applySeed(ids: string[]) {
    onChangeSubjectIds(ids);
  }

  function pickHit(hit: SubjectSearchHit) {
    // Don't clear the search or unfocus the input — investigators frequently
    // pick several subjects matching the same word ("military" → Military
    // sites, Checkpoints, Fortifications), and resetting after each click
    // forces them to retype. Toggling an already-added hit removes it,
    // mirroring the chip's × so the user can correct a wrong pick from the
    // same dropdown.
    toggleSubject(hit.subject.id);
  }

  function pickOsmHit(hit: OsmTagHit) {
    // Same multi-pick behaviour as pickHit — keep the search live so the
    // investigator can grab several OSM tags ("bench", "picnic_table",
    // "trash") from one search.
    toggleCustomTag(hit.entry.key, hit.entry.value);
  }

  const totalHits = curatedHits.length + osmHits.length;
  const showDropdown = (searchFocused || trimmed.length > 0) && totalHits > 0;

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
          <div
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-96 overflow-y-auto rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] shadow-[0_8px_24px_-8px_rgba(26,23,20,0.25)]"
          >
            {curatedHits.length > 0 && (
              <>
                <DropdownEyebrow>HR-curated</DropdownEyebrow>
                <ul role="listbox">
                  {curatedHits.map((hit) => {
                    const already = selectedSet.has(hit.subject.id);
                    return (
                      <li key={hit.subject.id} role="option" aria-selected={already}>
                        <button
                          type="button"
                          onClick={() => pickHit(hit)}
                          className={[
                            "flex w-full items-center gap-2 px-3 py-2 text-left",
                            "hover:bg-[var(--color-surface-sunken)] focus:bg-[var(--color-surface-sunken)] focus:outline-none",
                            already && "bg-[var(--color-surface-sunken)]/40",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          aria-label={already ? `Remove ${hit.subject.label}` : `Add ${hit.subject.label}`}
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
              </>
            )}

            {osmHits.length > 0 && (
              <>
                <DropdownEyebrow>All OSM tags</DropdownEyebrow>
                <ul role="listbox">
                  {osmHits.map((hit) => {
                    const tk = `${hit.entry.key}=${hit.entry.value}`;
                    const already = customTagKeySet.has(tk);
                    return (
                      <li key={tk} role="option" aria-selected={already}>
                        <button
                          type="button"
                          onClick={() => pickOsmHit(hit)}
                          className={[
                            "flex w-full items-center gap-2 px-3 py-2 text-left",
                            "hover:bg-[var(--color-surface-sunken)] focus:bg-[var(--color-surface-sunken)] focus:outline-none",
                            already && "bg-[var(--color-surface-sunken)]/40",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          aria-label={already ? `Remove ${tk}` : `Add ${tk}`}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-[var(--font-mono)] text-[12px] text-[var(--color-ink)]">
                              <span className="text-[var(--color-ink-faint)]">
                                {hit.entry.key}=
                              </span>
                              {hit.entry.value}
                            </span>
                            <span className="text-[10px] text-[var(--color-ink-faint)]">
                              used {formatCount(hit.entry.count)} times on OSM
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
              </>
            )}
          </div>
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
          {customTags.map((tag) => (
            <CustomTagChip
              key={tagKey(tag)}
              tag={tag}
              onRemove={() => toggleCustomTag(tag.key, tag.value)}
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

      {/* Generated-query disclosure — collapsed by default. The chevron and
          eyebrow style mirror the rest of the editor; the body is the same
          monospaced QL the Raw-mode textarea would emit. Provides a
          learn-while-you-build affordance without intimidating users who
          don't care about syntax. */}
      {hasSelection && (
        <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-sunken)]">
          <button
            type="button"
            onClick={() => setShowGeneratedQL((v) => !v)}
            aria-expanded={showGeneratedQL}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-sunken)]/60"
          >
            <span className="flex items-center gap-2">
              <span
                className="uppercase text-[var(--color-ink-faint)]"
                style={{ fontSize: "10px", letterSpacing: "0.22em", fontWeight: 600 }}
              >
                Generated query
              </span>
              <span className="text-[10px] text-[var(--color-ink-faint)]">
                ({generatedQL.split("\n").length} lines)
              </span>
            </span>
            <span aria-hidden className="text-[11px] text-[var(--color-ink-faint)]">
              {showGeneratedQL ? "▴" : "▾"}
            </span>
          </button>
          {showGeneratedQL && (
            <div className="border-t border-[var(--color-line)] px-3 py-2.5">
              <pre className="overflow-x-auto whitespace-pre rounded bg-[var(--color-surface-raised)] px-2.5 py-2 font-[var(--font-mono)] text-[11px] leading-relaxed text-[var(--color-ink)]">
                {generatedQL}
              </pre>
              <p className="mt-1.5 text-[10px] italic text-[var(--color-ink-faint)]">
                This is what runs against overpass-api.de when you hit Run.{" "}
                <code className="font-[var(--font-mono)]">{"{{bbox}}"}</code>{" "}
                gets substituted with your selected region.
              </p>
            </div>
          )}
        </div>
      )}

      <SubjectPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selectedIds={selectedSubjectIds}
        onToggleSubject={toggleSubject}
      />
    </div>
  );
}

function tagKey(t: CustomTag): string {
  return t.value === null ? t.key : `${t.key}=${t.value}`;
}

function DropdownEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="border-b border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-3 py-1 uppercase text-[var(--color-ink-faint)]"
      style={{ fontSize: "9px", letterSpacing: "0.22em", fontWeight: 600 }}
    >
      {children}
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return n.toLocaleString();
}
