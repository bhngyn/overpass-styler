/**
 * CustomTagChip — pill for a user-picked OSM tag that isn't in the curated
 * subject catalog. Picked from the SubjectPicker's "All OSM tags" section.
 *
 * Visually similar to SubjectChip but smaller and clearly typographically
 * "raw" — the OSM ``key=value`` shows in mono font, with a distinct
 * "OSM TAG" eyebrow so the investigator can tell at a glance that this
 * pick bypassed the editorial layer.
 */

import { TAGINFO_SNAPSHOT } from "@/lib/taginfoSnapshot";
import type { CustomTag } from "@/lib/queryBuilder";

interface Props {
  tag: CustomTag;
  onRemove: () => void;
}

export function CustomTagChip({ tag, onRemove }: Props) {
  const label = tag.value === null ? `${tag.key}=*` : `${tag.key}=${tag.value}`;
  const snapshot =
    tag.value !== null ? TAGINFO_SNAPSHOT[`${tag.key}=${tag.value}`] : null;
  const wikiUrl =
    snapshot?.wikiUrl ??
    (tag.value
      ? `https://wiki.openstreetmap.org/wiki/Tag:${encodeURIComponent(tag.key)}=${encodeURIComponent(tag.value)}`
      : `https://wiki.openstreetmap.org/wiki/Key:${encodeURIComponent(tag.key)}`);

  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span
          className="uppercase text-[var(--color-ink-faint)]"
          style={{ fontSize: "9px", letterSpacing: "0.2em", fontWeight: 600 }}
        >
          OSM tag
        </span>
        <span className="flex-1 truncate font-[var(--font-mono)] text-[12px] text-[var(--color-ink)]">
          {label}
        </span>
        <a
          href={wikiUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-[var(--color-accent)] hover:underline"
          title="Open the OSM wiki page in a new tab"
        >
          wiki ↗
        </a>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="rounded p-0.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-danger)]"
        >
          <span aria-hidden className="text-base leading-none">
            ×
          </span>
        </button>
      </div>
      {snapshot?.description && (
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
          {truncate(snapshot.description, 220)}
        </p>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}
