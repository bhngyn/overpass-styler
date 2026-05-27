/**
 * TagDetailPanel — right column of the Tag Library drawer.
 *
 * Three content layers, rendered top-to-bottom in order of editorial trust:
 *
 *  1. **Field note** — when a curated glossary entry matches the selected
 *     ``key=value`` pair, surface the hand-written editorial guidance in a
 *     paper-tan callout. This is the gold; it goes above everything else.
 *  2. **Wiki summary** — Taginfo's ``tag/wiki_pages`` description (plain
 *     text, English preferred). Optional thumbnail.
 *  3. **Related tags** — chip rail from the wiki page's combination /
 *     implied / linked tag lists, each clickable to navigate within the
 *     drawer.
 *
 * Two insert actions at the bottom:
 *  - Primary  → ``["key"="value"]`` (cursor splice, no full query).
 *  - Secondary → ``nwr["key"="value"]({{bbox}});`` (full QL line).
 *
 * The "Open full wiki page ↗︎" link always renders — it's the canonical
 * source even when Taginfo's summary is empty.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import type {
  GlossaryEntry,
  MergedTagResponse,
  TaginfoImage,
  TaginfoWikiPage,
} from "@/lib/tagLibrary.types";

export interface TagDetailPanelProps {
  /** Selected key (always required when this column is mounted). */
  keyName: string;
  /** Selected value (always required when this column is mounted). */
  value: string;
  /**
   * Optional curated entry pre-loaded from the Browse column's click — when
   * the investigator picks a curated row, we already have the editorial
   * payload locally, so we can render the field-note instantly without
   * waiting on Taginfo. We still kick off the network call to fill in the
   * wiki summary; the local entry is just the "first paint" optimisation.
   */
  preloadedCurated?: GlossaryEntry | null;
  /** Insert action — see drawer for the wrapping conventions. */
  onInsert: (clause: string) => void;
  /** Navigate to a related tag within the drawer. */
  onNavigate: (key: string, value: string) => void;
  /** Network-call confirmation. */
  requireConfirmation: () => Promise<boolean>;
}

interface FetchState {
  loading: boolean;
  data: MergedTagResponse | null;
  error: string | null;
  /** ``key=value`` cache key — guards against stale fetches. */
  forTag: string;
}

export function TagDetailPanel({
  keyName,
  value,
  preloadedCurated,
  onInsert,
  onNavigate,
  requireConfirmation,
}: TagDetailPanelProps) {
  const tagKey = `${keyName}=${value}`;
  const [state, setState] = useState<FetchState>({
    loading: true,
    data: null,
    error: null,
    forTag: tagKey,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ loading: true, data: null, error: null, forTag: tagKey });
      const ok = await requireConfirmation();
      if (!ok || cancelled) {
        setState({
          loading: false,
          data: null,
          error: "Network call declined.",
          forTag: tagKey,
        });
        return;
      }
      try {
        const data = await api.tagLibrary.tag(keyName, value);
        if (cancelled) return;
        setState({ loading: false, data, error: null, forTag: tagKey });
      } catch (err) {
        if (cancelled) return;
        setState({
          loading: false,
          data: null,
          error: err instanceof Error ? err.message : "Failed to load tag",
          forTag: tagKey,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagKey]);

  // The curated entry preference: prefer the fetched one (carries authoritative
  // backend state), fall back to the preloaded one so the field-note renders
  // immediately on click.
  const curated = state.data?.curated ?? preloadedCurated ?? null;
  const wiki = extractBestWikiPage(state.data);
  const description = wiki?.description ?? extractDescriptionFromEnvelope(state.data);
  const image = wiki?.image ?? null;
  const wikiUrl =
    state.data?.wiki_url ??
    `https://wiki.openstreetmap.org/wiki/Tag:${encodeURIComponent(keyName)}%3D${encodeURIComponent(value)}`;
  const related = collectRelatedTags(wiki, curated);

  const insertSimple = () => onInsert(`["${keyName}"="${value}"]`);
  const insertFullLine = () => onInsert(`nwr["${keyName}"="${value}"]({{bbox}});`);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="border-b border-[var(--color-line)] px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="font-[var(--font-mono)] text-base text-[var(--color-ink)]">
            <span className="text-[var(--color-ink-soft)]">{keyName}</span>
            <span className="text-[var(--color-ink-faint)]">=</span>
            <span>{value}</span>
          </h2>
        </div>
        {curated && (
          <p className="mt-0.5 font-[var(--font-display)] text-xs italic text-[var(--color-ink-soft)]">
            {curated.label}
          </p>
        )}
      </header>

      {/* Scrolling body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {curated && <FieldNote entry={curated} />}

        {state.loading && (
          <p className="text-xs text-[var(--color-ink-faint)]">Loading from Taginfo…</p>
        )}

        {!state.loading && state.error && (
          <p className="text-xs text-[var(--color-danger)]">{state.error}</p>
        )}

        {description && (
          <section>
            <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--color-ink-faint)]">
              From the OSM Wiki
            </h3>
            {description.split(/\n+/).map((para, i) => (
              <p
                key={i}
                className="mb-2 text-sm leading-relaxed text-[var(--color-ink)]"
              >
                {para}
              </p>
            ))}
          </section>
        )}

        {image && (image.thumb_url || image.image_url) && (
          <figure className="rounded border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-2">
            <img
              src={image.thumb_url ?? image.image_url ?? ""}
              alt={image.title ?? `${keyName}=${value}`}
              className="block max-h-48 w-full object-contain"
            />
            {image.title && (
              <figcaption className="mt-1 text-[10px] italic text-[var(--color-ink-faint)]">
                {image.title}
              </figcaption>
            )}
          </figure>
        )}

        {related.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--color-ink-faint)]">
              Related tags
            </h3>
            <div className="flex flex-wrap gap-1">
              {related.map((r) => (
                <button
                  key={`${r.key}=${r.value ?? "*"}`}
                  type="button"
                  disabled={!r.value}
                  onClick={() => r.value && onNavigate(r.key, r.value)}
                  className={[
                    "rounded border px-2 py-0.5 font-[var(--font-mono)] text-[11px] transition-colors",
                    r.value
                      ? "border-[var(--color-line)] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                      : "cursor-not-allowed border-[var(--color-line)] text-[var(--color-ink-faint)] opacity-60",
                  ].join(" ")}
                >
                  {r.value ? `${r.key}=${r.value}` : `${r.key}=*`}
                </button>
              ))}
            </div>
          </section>
        )}

        <section>
          <a
            href={wikiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline"
          >
            Open full wiki page <span aria-hidden>↗︎</span>
          </a>
        </section>
      </div>

      {/* Insert actions */}
      <footer className="space-y-2 border-t border-[var(--color-line)] px-4 py-3">
        <Button variant="primary" onClick={insertSimple} className="w-full justify-center">
          Insert into query
        </Button>
        <button
          type="button"
          onClick={insertFullLine}
          className="block w-full text-center text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-accent)] hover:underline"
        >
          Insert as full <code className="font-[var(--font-mono)]">nwr[…]({"{{bbox}}"});</code> line
        </button>
      </footer>
    </div>
  );
}

interface FieldNoteProps {
  entry: GlossaryEntry;
}

/** The editorial callout — paper-tan tint, thin accent border, small-caps eyebrow. */
function FieldNote({ entry }: FieldNoteProps) {
  return (
    <div
      className="rounded-md border-l-2 border-[var(--color-accent)] px-3 py-2.5"
      style={{ background: "#fbf6e8" }}
    >
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-accent)]">
        Field note
      </h3>
      <p className="mt-1 font-[var(--font-display)] text-sm italic leading-snug text-[#3a2e1a]">
        {entry.field_note}
      </p>
      {entry.default_overpass_clause && (
        <p className="mt-2 truncate font-[var(--font-mono)] text-[10px] text-[#5b4a2a]">
          Suggested: {entry.default_overpass_clause}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Taginfo payload helpers
// ---------------------------------------------------------------------------

/**
 * Pick the best wiki page from the Taginfo envelope.
 *
 * Taginfo returns one page per language in ``data[]``. Prefer English
 * (``lang === "en"`` or ``language_en === "English"``); fall back to the
 * first page if no English entry is available.
 */
function extractBestWikiPage(data: MergedTagResponse | null): TaginfoWikiPage | null {
  if (!data) return null;
  const pages = data.taginfo.data;
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const en = pages.find(
    (p) =>
      (typeof p.lang === "string" && p.lang.toLowerCase() === "en") ||
      (typeof p.language === "string" && p.language.toLowerCase() === "en") ||
      (typeof p.language_en === "string" &&
        p.language_en.toLowerCase() === "english"),
  );
  return en ?? pages[0] ?? null;
}

/** Some responses surface a description on the envelope instead of pages. */
function extractDescriptionFromEnvelope(data: MergedTagResponse | null): string | null {
  if (!data) return null;
  if (typeof data.taginfo.description === "string" && data.taginfo.description) {
    return data.taginfo.description;
  }
  return null;
}

/**
 * Build a deduplicated list of related ``key[=value]`` chips from the wiki
 * page's combination/implied/linked arrays plus the curated entry's
 * ``related_tags``. Order: curated first (editorial trust), then wiki.
 */
function collectRelatedTags(
  page: TaginfoWikiPage | null,
  curated: GlossaryEntry | null,
): Array<{ key: string; value: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; value: string | null }> = [];

  const push = (raw: string) => {
    const parsed = parseTagPair(raw);
    if (!parsed) return;
    const dedupeKey = `${parsed.key}=${parsed.value ?? "*"}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push(parsed);
  };

  if (curated) {
    for (const r of curated.related_tags) push(r);
  }
  if (page) {
    for (const arr of [
      page.tags_implies,
      page.tags_combination,
      page.tags_linked,
    ]) {
      if (Array.isArray(arr)) {
        for (const r of arr) {
          if (typeof r === "string") push(r);
        }
      }
    }
  }
  return out;
}

/**
 * Parse OSM ``key=value`` / ``key=*`` / bare ``key`` strings into structured
 * pairs. Whitespace tolerated; an empty / unparseable input yields null.
 */
function parseTagPair(raw: string): { key: string; value: string | null } | null {
  const s = raw.trim();
  if (!s) return null;
  const eq = s.indexOf("=");
  if (eq < 0) return { key: s, value: null };
  const key = s.slice(0, eq).trim();
  const value = s.slice(eq + 1).trim();
  if (!key) return null;
  if (!value || value === "*") return { key, value: null };
  return { key, value };
}

// Re-export the type guard so consumers that want to render image previews
// elsewhere can ride along. Not part of the public surface; kept here to
// avoid orphaning the import.
export type { TaginfoImage };
