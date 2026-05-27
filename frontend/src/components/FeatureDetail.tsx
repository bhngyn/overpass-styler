/**
 * FeatureDetail — full-rail replacement view for one OSM feature in Browse.
 *
 * Rendered when the parent BrowseMode hands us a selectedOsmId. Replaces the
 * InventoryRail content (drilldown or domain cards) until the user clicks
 * back. Shows:
 *
 * - Back arrow → clears selection in the parent.
 * - Serif feature name (or 〈unnamed〉 in muted italic).
 * - "OSM TAGS" eyebrow + two-column table — same visual treatment as the
 *   export-balloon tag table.
 * - External links (OSM always; Wikidata + Wikipedia when present).
 * - Three handoff buttons → spawns BakeHandoffModal pre-filled per mode.
 *
 * The component owns its API fetch (mounting fetches feature detail; the
 * parent only knows the osm_id). This keeps BrowseMode's state simple.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import type {
  BrowseBbox,
  BrowseFeatureDetail,
} from "@/lib/types";

export type BakeHandoffPrefill =
  | {
      mode: "find-more";
      bbox: BrowseBbox;
      query: string;
      defaultName: string;
    }
  | {
      mode: "area-by-tag";
      bbox: BrowseBbox;
      query: string;
      defaultName: string;
    }
  | {
      mode: "single";
      single_osm_id: string;
      defaultName: string;
    };

interface Props {
  osmId: string;
  bbox: BrowseBbox;
  onBack: () => void;
  onOpenBake: (prefill: BakeHandoffPrefill) => void;
}

export function FeatureDetail({ osmId, bbox, onBack, onOpenBake }: Props) {
  const [detail, setDetail] = useState<BrowseFeatureDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    (async () => {
      try {
        const result = await api.browse.item(osmId);
        if (!cancelled) setDetail(result);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [osmId]);

  const dominantTag = detail ? dominantTagPair(detail.tags) : null;
  const displayName = detail?.name ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface-raised)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
          aria-label="Back to inventory"
          title="Back"
        >
          ←
        </button>
        <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
          Feature detail
        </span>
        <code className="ml-auto font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]" title={osmId}>
          {osmId}
        </code>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="p-4 text-sm text-[var(--color-danger)]">{error}</div>
        )}
        {!error && loading && (
          <div className="p-4 text-sm italic text-[var(--color-ink-faint)]">
            Loading feature…
          </div>
        )}
        {!error && !loading && detail && (
          <>
            {/* Header */}
            <div className="border-b border-[var(--color-line)] px-4 py-4">
              {dominantTag && (
                <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-accent)]">
                  {dominantTag.key} · {dominantTag.value}
                </div>
              )}
              <h2
                className={[
                  "mt-1 font-[var(--font-display)] text-xl leading-tight",
                  displayName
                    ? "text-[var(--color-ink)]"
                    : "italic text-[var(--color-ink-faint)]",
                ].join(" ")}
              >
                {displayName ?? "〈unnamed〉"}
              </h2>
              <div className="mt-1 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
                {detail.geometry.kind}
                {detail.geometry.point && (
                  <>
                    {" · "}
                    {detail.geometry.point[1].toFixed(4)},{" "}
                    {detail.geometry.point[0].toFixed(4)}
                  </>
                )}
              </div>
            </div>

            {/* Tag table */}
            {Object.keys(detail.tags).length > 0 && (
              <div className="border-b border-[var(--color-line)] px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
                  OSM tags
                </div>
                <table className="mt-1.5 w-full table-fixed border-collapse">
                  <tbody>
                    {Object.entries(detail.tags).map(([k, v], i) => (
                      <tr
                        key={k}
                        className={
                          i % 2 === 0
                            ? "bg-[var(--color-surface)]"
                            : "bg-[var(--color-surface-sunken)]"
                        }
                      >
                        <td
                          className="w-2/5 truncate px-2 py-1 align-top font-[var(--font-mono)] text-[11px] text-[var(--color-ink-soft)]"
                          title={k}
                        >
                          {k}
                        </td>
                        <td className="break-words px-2 py-1 align-top text-[11px] text-[var(--color-ink)]">
                          {v}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* External links */}
            {detail.wiki_links.length > 0 && (
              <div className="border-b border-[var(--color-line)] px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
                  External links
                </div>
                <ul className="mt-1.5 space-y-1">
                  {detail.wiki_links.map((link) => (
                    <li key={link.url}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline"
                      >
                        {externalLinkLabel(link.kind, link.label)}
                        <span aria-hidden="true">↗</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Actions */}
            <div className="px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
                Send to project
              </div>
              <div className="mt-2 space-y-1.5">
                {dominantTag && (
                  <Button
                    variant="primary"
                    className="w-full justify-center"
                    onClick={() =>
                      onOpenBake({
                        mode: "find-more",
                        bbox,
                        query: findMoreQuery(dominantTag),
                        defaultName: `${dominantTag.key}=${dominantTag.value}`,
                      })
                    }
                  >
                    Find more like this
                  </Button>
                )}
                {dominantTag && (
                  <Button
                    variant="secondary"
                    className="w-full justify-center"
                    onClick={() =>
                      onOpenBake({
                        mode: "area-by-tag",
                        bbox,
                        query: areaByTagQuery(dominantTag),
                        defaultName: `${dominantTag.key}=${dominantTag.value} in bbox`,
                      })
                    }
                  >
                    Save area to project as layer
                  </Button>
                )}
                <Button
                  variant="secondary"
                  className="w-full justify-center"
                  onClick={() =>
                    onOpenBake({
                      mode: "single",
                      single_osm_id: detail.osm_id,
                      defaultName: detail.name ?? detail.osm_id,
                    })
                  }
                >
                  Save single feature
                </Button>
              </div>
              {!dominantTag && (
                <p className="mt-2 text-[11px] italic text-[var(--color-ink-faint)]">
                  This feature has no recognised primary tag — "find more like
                  this" and "save area" need a tag pair to bake against. Save
                  the single feature instead.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Pick the dominant tag pair for the actions. Same heuristic as
 * InventoryRail's row decoration so the user sees consistent labelling. */
function dominantTagPair(tags: Record<string, string>): { key: string; value: string } | null {
  const skip = new Set([
    "name", "ref", "source", "fixme", "note", "@id",
    "wikidata", "wikipedia", "operator", "addr:city",
  ]);
  const priority = ["amenity", "building", "landuse", "historic", "military", "natural", "man_made", "highway"];
  for (const k of priority) {
    if (tags[k]) return { key: k, value: tags[k] };
  }
  for (const [k, v] of Object.entries(tags)) {
    if (!skip.has(k) && !k.startsWith("name:") && !k.startsWith("source:") && !k.startsWith("addr:")) {
      return { key: k, value: v };
    }
  }
  return null;
}

function findMoreQuery(tag: { key: string; value: string }): string {
  // `{{bbox}}` is a backend placeholder substituted at bake time; this
  // matches the Compose-step Snippets convention.
  return `[out:json][timeout:60];\nnwr["${tag.key}"="${tag.value}"]({{bbox}});\nout body geom;`;
}

function areaByTagQuery(tag: { key: string; value: string }): string {
  // Same shape as findMoreQuery in v1; we keep them separate so we can
  // diverge later (e.g. area-by-tag could include node+way+relation
  // explicitly, find-more could add `[out:json][timeout:N]; out count;`
  // for a preview).
  return `[out:json][timeout:60];\nnwr["${tag.key}"="${tag.value}"]({{bbox}});\nout body geom;`;
}

function externalLinkLabel(kind: string, fallback: string): string {
  if (kind === "openstreetmap") return "View on OpenStreetMap";
  if (kind === "wikidata") return `Wikidata · ${fallback}`;
  if (kind === "wikipedia") return `Wikipedia · ${fallback}`;
  return fallback;
}
