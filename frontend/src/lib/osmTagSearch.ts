/**
 * Offline OSM-tag search — ranks entries from ``taginfoIndex.ts``.
 *
 * The investigator types a query into the SubjectPicker; we match it
 * against the bundled tag index (no network) and return ranked hits.
 * Ranking layers (best → worst), then popularity within each layer:
 *
 *   1. Exact match on ``key=value``  (``amenity=bench`` typed verbatim)
 *   2. Exact match on the value side (``bench``)
 *   3. Exact match on the key side  (``amenity``)
 *   4. Prefix match on value
 *   5. Prefix match on key
 *   6. Substring match on either side
 *
 * Ties broken by ``count`` descending — global OSM usage popularity, so
 * the more useful tags float to the top of each tier.
 */

import { TAGINFO_INDEX, type TaginfoIndexEntry } from "@/lib/taginfoIndex";

export interface OsmTagHit {
  entry: TaginfoIndexEntry;
  /** Which side of the pair matched and how strongly — useful for the
   *  picker UI to highlight the matched span. */
  matched: "key=value" | "value-exact" | "key-exact" | "value-prefix" |
    "key-prefix" | "substring";
}

const RANK_ORDER: OsmTagHit["matched"][] = [
  "key=value",
  "value-exact",
  "key-exact",
  "value-prefix",
  "key-prefix",
  "substring",
];

function rankOf(matched: OsmTagHit["matched"]): number {
  return RANK_ORDER.indexOf(matched);
}

/** Search the offline OSM tag index.
 *
 *  Returns up to ``limit`` hits, ranked best-first. Empty / whitespace
 *  queries return an empty list (no "show everything" mode — callers
 *  drive a separate browse UI for that if needed).
 *
 *  The function is pure and synchronous; no debouncing or caching
 *  needed at the call site, but for large indexes (~10k+ entries) the
 *  caller should still memoise across renders.
 */
export function searchOsmTags(q: string, limit = 50): OsmTagHit[] {
  const ql = q.trim().toLowerCase();
  if (!ql) return [];

  // Detect a literal ``key=value`` query and short-circuit it: investigators
  // who already know the tag they want should land on it instantly.
  const equalsIdx = ql.indexOf("=");
  const queryKey = equalsIdx >= 0 ? ql.slice(0, equalsIdx).trim() : null;
  const queryValue = equalsIdx >= 0 ? ql.slice(equalsIdx + 1).trim() : null;

  const hits: OsmTagHit[] = [];
  for (const entry of TAGINFO_INDEX) {
    const kl = entry.key.toLowerCase();
    const vl = entry.value.toLowerCase();

    if (queryKey !== null && queryValue !== null) {
      // Form: ``k=v``. Only consider entries that match both sides.
      if (kl === queryKey && vl === queryValue) {
        hits.push({ entry, matched: "key=value" });
      } else if (
        queryKey &&
        queryValue &&
        kl.includes(queryKey) &&
        vl.includes(queryValue)
      ) {
        hits.push({ entry, matched: "substring" });
      }
      continue;
    }

    // Plain query — try each match strength in order, taking the strongest.
    let matched: OsmTagHit["matched"] | null = null;
    if (vl === ql) matched = "value-exact";
    else if (kl === ql) matched = "key-exact";
    else if (vl.startsWith(ql)) matched = "value-prefix";
    else if (kl.startsWith(ql)) matched = "key-prefix";
    else if (vl.includes(ql) || kl.includes(ql)) matched = "substring";

    if (matched) hits.push({ entry, matched });
  }

  hits.sort((a, b) => {
    const r = rankOf(a.matched) - rankOf(b.matched);
    if (r !== 0) return r;
    return b.entry.count - a.entry.count;
  });

  return hits.slice(0, limit);
}

/** Group hits by their ``key`` for the picker's "organized by key" layout.
 *
 *  Preserves the within-group ranking from ``searchOsmTags`` (entries
 *  stay in the order they appeared), and groups are ordered by the rank
 *  of their first entry — so the section containing the strongest hit
 *  appears at the top.
 */
export function groupHitsByKey(hits: readonly OsmTagHit[]): {
  key: string;
  hits: OsmTagHit[];
}[] {
  const groups = new Map<string, OsmTagHit[]>();
  for (const hit of hits) {
    const k = hit.entry.key;
    const list = groups.get(k);
    if (list) list.push(hit);
    else groups.set(k, [hit]);
  }
  return Array.from(groups, ([key, h]) => ({ key, hits: h }));
}
