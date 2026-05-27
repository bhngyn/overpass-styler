/**
 * SubjectPicker — slide-in drawer for visually browsing the curated subject
 * catalog. **Browse-only**: the single search surface lives in the inline
 * WHAT TO FIND box in QueryBuilder, which covers both curated subjects and
 * the full offline OSM tag index. This picker exists as a tile-grid
 * affordance for investigators who prefer to skim what's available rather
 * than type — featured row at the top, full grouped sections below.
 */

import { useEffect, useMemo } from "react";
import {
  SUBJECT_CATALOG,
  SUBJECT_GROUP_LABELS,
  SUBJECT_GROUP_ORDER,
  featuredSubjects,
  subjectsByGroup,
  type Subject,
} from "@/lib/subjectCatalog";

interface Props {
  open: boolean;
  onClose: () => void;
  selectedIds: string[];
  onToggleSubject: (subjectId: string) => void;
}

export function SubjectPicker({
  open,
  onClose,
  selectedIds,
  onToggleSubject,
}: Props) {
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
        aria-label="Browse subject catalog"
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
                Browse the subject catalog
              </h2>
              <p className="mt-1 text-[11px] text-[var(--color-ink-soft)]">
                Tap a tile to add or remove. To find specific tags ({" "}
                <code className="font-[var(--font-mono)]">amenity=bench</code>,{" "}
                <code className="font-[var(--font-mono)]">cctv</code>, …) use
                the search box back in the editor — it covers every OSM tag.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close subject browser"
              className="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)]"
            >
              <span aria-hidden className="text-xl leading-none">
                ×
              </span>
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <SectionEyebrow>Common in HR work</SectionEyebrow>
          <TileGrid>
            {featured.map((subject) => (
              <SubjectTile
                key={subject.id}
                subject={subject}
                selected={selectedSet.has(subject.id)}
                onClick={() => onToggleSubject(subject.id)}
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
                      onClick={() => onToggleSubject(subject.id)}
                    />
                  ))}
                </TileGrid>
              </div>
            );
          })}
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
