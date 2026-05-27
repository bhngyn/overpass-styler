/**
 * SubjectPicker — slide-in drawer for picking subjects in the Query Builder.
 *
 * Layout: a featured "Common in HR work" row at the top, followed by
 * grouped sections (Detention, Civilian, …). A search input lives in the
 * header — typing replaces the grouped body with a flat ranked list of
 * hits. When the curated catalog has nothing for the query, a zero-result
 * card offers an escape hatch into the full OSM Tag Library.
 *
 * Backdrop + slide animation mirror TagLibraryDrawer; this component owns
 * its own copy of the pattern by design (don't share state with that
 * drawer, the affordances differ).
 */

import { useEffect, useMemo, useState } from "react";
import {
  SUBJECT_CATALOG,
  SUBJECT_GROUP_LABELS,
  SUBJECT_GROUP_ORDER,
  featuredSubjects,
  searchSubjects,
  subjectsByGroup,
  type Subject,
  type SubjectSearchHit,
} from "@/lib/subjectCatalog";
import type { GlossaryEntry } from "@/lib/tagLibrary.types";

interface Props {
  open: boolean;
  onClose: () => void;
  glossaryEntries: GlossaryEntry[];
  selectedIds: string[];
  onToggle: (subjectId: string) => void;
  onOpenTagLibrary?: () => void;
}

export function SubjectPicker({
  open,
  onClose,
  glossaryEntries,
  selectedIds,
  onToggle,
  onOpenTagLibrary,
}: Props) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const trimmed = query.trim();
  const hits = useMemo(
    () => (trimmed ? searchSubjects(trimmed, glossaryEntries, SUBJECT_CATALOG, 30) : []),
    [trimmed, glossaryEntries],
  );

  const featured = useMemo(() => featuredSubjects(SUBJECT_CATALOG), []);
  const featuredIds = useMemo(() => new Set(featured.map((s) => s.id)), [featured]);
  const grouped = useMemo(() => subjectsByGroup(SUBJECT_CATALOG), []);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  return (
    <>
      <div
        aria-hidden={!open}
        onClick={onClose}
        className={[
          "fixed inset-0 z-40 bg-[var(--color-ink)]/30 transition-opacity duration-200",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Pick a kind of place"
        aria-hidden={!open}
        className={[
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-[720px] flex-col",
          "border-l border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl",
          "transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        <header className="shrink-0 border-b border-[var(--color-line)] bg-[var(--color-surface-raised)] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p
                className="uppercase text-[var(--color-ink-faint)]"
                style={{ fontSize: "10px", letterSpacing: "0.22em", fontWeight: 600 }}
              >
                Query Builder
              </p>
              <h2 className="font-[var(--font-display)] text-lg text-[var(--color-ink)]">
                Pick a kind of place
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close subject picker"
              className="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)]"
            >
              <span aria-hidden className="text-xl leading-none">
                ×
              </span>
            </button>
          </div>
          <div className="mt-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search subjects: prisons, hospitals, churches…"
              className={[
                "w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)]",
                "px-3 py-1.5 text-sm text-[var(--color-ink)]",
                "placeholder:text-[var(--color-ink-faint)]",
                "focus:border-[var(--color-accent)] focus:outline-none",
              ].join(" ")}
            />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {trimmed ? (
            hits.length > 0 ? (
              <SearchResults
                hits={hits}
                selectedSet={selectedSet}
                onToggle={onToggle}
              />
            ) : (
              <ZeroResult q={trimmed} onOpenTagLibrary={onOpenTagLibrary} />
            )
          ) : (
            <>
              <SectionEyebrow>Common in HR work</SectionEyebrow>
              <TileGrid>
                {featured.map((subject) => (
                  <SubjectTile
                    key={subject.id}
                    subject={subject}
                    selected={selectedSet.has(subject.id)}
                    onClick={() => onToggle(subject.id)}
                  />
                ))}
              </TileGrid>

              {SUBJECT_GROUP_ORDER.map((group) => {
                const items = grouped[group].filter((s) => !featuredIds.has(s.id));
                if (items.length === 0) return null;
                return (
                  <div key={group} className="mt-6">
                    <SectionEyebrow>{SUBJECT_GROUP_LABELS[group]}</SectionEyebrow>
                    <TileGrid>
                      {items.map((subject) => (
                        <SubjectTile
                          key={subject.id}
                          subject={subject}
                          selected={selectedSet.has(subject.id)}
                          onClick={() => onToggle(subject.id)}
                        />
                      ))}
                    </TileGrid>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mb-2 uppercase text-[var(--color-ink-faint)]"
      style={{ fontSize: "10px", letterSpacing: "0.22em", fontWeight: 600 }}
    >
      {children}
    </p>
  );
}

function TileGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-2">{children}</div>;
}

interface TileProps {
  subject: Subject;
  selected: boolean;
  onClick: () => void;
}

function SubjectTile({ subject, selected, onClick }: TileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={subject.description}
      className={[
        "flex h-[120px] flex-col items-center justify-center gap-2 rounded-md border bg-[var(--color-surface-raised)] px-2 py-3 text-center transition-colors",
        selected
          ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]"
          : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]",
      ].join(" ")}
    >
      <span aria-hidden className="text-2xl leading-none">
        {subject.icon}
      </span>
      <span
        className="line-clamp-2 text-[12px] leading-tight text-[var(--color-ink)]"
        style={{ fontWeight: 500 }}
      >
        {subject.label}
      </span>
    </button>
  );
}

interface SearchResultsProps {
  hits: SubjectSearchHit[];
  selectedSet: Set<string>;
  onToggle: (id: string) => void;
}

function SearchResults({ hits, selectedSet, onToggle }: SearchResultsProps) {
  return (
    <ul className="space-y-1">
      {hits.map((hit) => {
        const selected = selectedSet.has(hit.subject.id);
        return (
          <li key={hit.subject.id}>
            <button
              type="button"
              onClick={() => onToggle(hit.subject.id)}
              aria-pressed={selected}
              className={[
                "flex w-full items-center gap-3 rounded-md border bg-[var(--color-surface-raised)] px-3 py-2 text-left transition-colors",
                selected
                  ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]"
                  : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]",
              ].join(" ")}
            >
              <span aria-hidden className="text-xl leading-none">
                {hit.subject.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-[var(--color-ink)]">
                  {hit.subject.label}
                </span>
                <span className="truncate text-[11px] text-[var(--color-ink-faint)]">
                  <FieldLabel field={hit.matchedField} />{" "}
                  <HitMatch hit={hit} />
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FieldLabel({ field }: { field: SubjectSearchHit["matchedField"] }) {
  const label =
    field === "alias"
      ? "alias"
      : field === "label"
        ? "name"
        : field === "tag"
          ? "OSM tag"
          : field === "group"
            ? "group"
            : "description";
  return (
    <span
      className="mr-1 uppercase text-[var(--color-ink-faint)]"
      style={{ fontSize: "9px", letterSpacing: "0.18em", fontWeight: 600 }}
    >
      {label}
    </span>
  );
}

function HitMatch({ hit }: { hit: SubjectSearchHit }) {
  if (hit.matchedField === "tag") {
    return (
      <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-soft)]">
        {hit.matchedText}
      </span>
    );
  }
  return (
    <span className="text-[var(--color-ink-soft)]" style={{ fontWeight: 600 }}>
      {hit.matchedText}
    </span>
  );
}

interface ZeroResultProps {
  q: string;
  onOpenTagLibrary?: () => void;
}

function ZeroResult({ q, onOpenTagLibrary }: ZeroResultProps) {
  const disabled = !onOpenTagLibrary;
  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-4">
      <p className="text-sm text-[var(--color-ink)]">
        No HR-curated subjects match{" "}
        <span className="font-[var(--font-mono)] text-[12px]">"{q}"</span>.
      </p>
      <button
        type="button"
        onClick={() => onOpenTagLibrary?.()}
        disabled={disabled}
        title={
          disabled
            ? "Advanced tag library is not available here."
            : "Open the full OSM tag library"
        }
        className={[
          "mt-2 inline-flex items-center gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2.5 py-1 text-[12px] transition-colors",
          disabled
            ? "cursor-not-allowed text-[var(--color-ink-faint)] opacity-60"
            : "text-[var(--color-ink-soft)] hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]",
        ].join(" ")}
      >
        Browse all OpenStreetMap tags (advanced) <span aria-hidden>→</span>
      </button>
    </div>
  );
}
