/**
 * SubjectChip — pill representing one selected Subject in the QueryBuilder.
 *
 * Shows the subject's icon + label with two affordances: an ``×`` remove
 * button and a ``▾`` disclosure that reveals a provenance panel. The
 * provenance is the investigator's audit trail — it documents which OSM
 * tags the subject expands to, the curated field note, and links out to
 * the OSM wiki for the underlying tag.
 */

import { useState } from "react";
import type { Subject } from "@/lib/subjectCatalog";
import type { GlossaryEntry } from "@/lib/tagLibrary.types";

interface Props {
  subject: Subject;
  glossaryEntries: GlossaryEntry[];
  onRemove: () => void;
}

export function SubjectChip({ subject, glossaryEntries, onRemove }: Props) {
  const [expanded, setExpanded] = useState(false);

  const entries = subject.glossaryEntryIds
    .map((id) => glossaryEntries.find((e) => e.id === id))
    .filter((e): e is GlossaryEntry => e !== undefined);

  const wikiTarget = entries[0];
  const wikiUrl = wikiTarget
    ? wikiTarget.value
      ? `https://wiki.openstreetmap.org/wiki/Tag:${wikiTarget.key}=${wikiTarget.value}`
      : `https://wiki.openstreetmap.org/wiki/Key:${wikiTarget.key}`
    : null;

  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)]">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span aria-hidden className="text-base leading-none">
          {subject.icon}
        </span>
        <span className="flex-1 truncate text-sm text-[var(--color-ink)]">
          {subject.label}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={
            expanded ? "Hide what this includes" : "Show what this includes"
          }
          className="rounded p-0.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)]"
        >
          <span aria-hidden className="text-[11px] leading-none">
            {expanded ? "▴" : "▾"}
          </span>
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${subject.label}`}
          className="rounded p-0.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-danger)]"
        >
          <span aria-hidden className="text-base leading-none">
            ×
          </span>
        </button>
      </div>

      {expanded && (
        <div className="border-t border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-3 py-2.5">
          <p
            className="uppercase text-[var(--color-ink-faint)]"
            style={{ fontSize: "10px", letterSpacing: "0.22em", fontWeight: 600 }}
          >
            Places tagged in OSM as:
          </p>
          {entries.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex gap-1.5 font-[var(--font-mono)] text-[11px] text-[var(--color-ink)]"
                >
                  <span aria-hidden className="text-[var(--color-ink-faint)]">
                    •
                  </span>
                  <span>
                    {entry.key}
                    {entry.value !== null && (
                      <>
                        =<span>{entry.value}</span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[11px] italic text-[var(--color-ink-faint)]">
              Loading tag details…
            </p>
          )}

          {entries.length > 0 && entries[0].field_note && (
            <p className="mt-2.5 text-[12px] leading-relaxed text-[var(--color-ink-soft)]">
              {entries[0].field_note}
            </p>
          )}

          <p
            className="mt-2.5 uppercase text-[var(--color-ink-faint)]"
            style={{ fontSize: "10px", letterSpacing: "0.22em", fontWeight: 600 }}
          >
            Typical results
          </p>
          <p className="mt-1 text-[12px] text-[var(--color-ink-soft)]">
            {subject.typicalResults}
          </p>

          {wikiUrl && (
            <a
              href={wikiUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
            >
              Open OSM wiki <span aria-hidden>↗</span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}
