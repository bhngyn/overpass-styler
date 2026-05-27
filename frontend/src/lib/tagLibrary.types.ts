/**
 * Tag Library types — mirror the Pydantic schemas in
 * ``backend/app/api/tag_library.py``. Keep field names in sync.
 *
 * Three layers of content surface through these types:
 *  1. Curated atrocity-investigation entries (``GlossaryEntry``) — offline,
 *     editorial.
 *  2. Taginfo passthroughs (``TaginfoKey``, ``TaginfoValue``) — global OSM
 *     usage counts + descriptions.
 *  3. ``MergedTagResponse`` — the ``/tag`` endpoint's combined view, with
 *     the Taginfo wiki payload, the matching curated entry (if any), and
 *     the canonical wiki URL.
 */

/** One of the seven atrocity-investigation domains (matches backend). */
export type GlossaryDomain =
  | "detention"
  | "mortality"
  | "destruction"
  | "military"
  | "displacement"
  | "civilian"
  | "evidence";

/** A single curated glossary entry. */
export interface GlossaryEntry {
  id: string;
  key: string;
  value: string | null;
  domain: GlossaryDomain;
  label: string;
  field_note: string;
  related_tags: string[];
  default_overpass_clause: string | null;
  default_icon_id: string | null;
}

export interface CuratedResponse {
  entries: GlossaryEntry[];
}

export interface TaginfoKey {
  key: string;
  count_all: number;
  count_all_fraction: number | null;
  in_wiki: boolean | null;
}

export interface TaginfoKeysResponse {
  data: TaginfoKey[];
}

export interface TaginfoValue {
  value: string;
  count: number;
  fraction: number | null;
  description: string | null;
}

export interface TaginfoValuesResponse {
  key: string;
  data: TaginfoValue[];
}

/**
 * Taginfo's ``/tag/wiki_pages`` envelope. Fields beyond what we render are
 * passed through as unknown — the backend returns the raw Taginfo payload so
 * we don't have to mirror its entire schema. Documented keys we read in the
 * frontend are declared explicitly; the rest live on ``[k: string]: unknown``.
 */
export interface TaginfoTagPayload {
  url?: string;
  data_until?: string;
  data?: TaginfoWikiPage[];
  // Sometimes the envelope places these at top level when the language matches
  // — keep them optional so the renderer can fall back gracefully.
  description?: string;
  image?: TaginfoImage | null;
  related_tags?: string[];
  [k: string]: unknown;
}

export interface TaginfoWikiPage {
  lang?: string;
  language?: string;
  language_en?: string;
  title?: string;
  description?: string;
  image?: TaginfoImage | null;
  on_node?: boolean;
  on_way?: boolean;
  on_area?: boolean;
  on_relation?: boolean;
  tags_implies?: string[];
  tags_combination?: string[];
  tags_linked?: string[];
  [k: string]: unknown;
}

export interface TaginfoImage {
  title?: string;
  thumb_url?: string | null;
  image_url?: string | null;
  [k: string]: unknown;
}

/** ``GET /api/tag-library/tag`` response. */
export interface MergedTagResponse {
  key: string;
  value: string;
  taginfo: TaginfoTagPayload;
  curated: GlossaryEntry | null;
  wiki_url: string;
}

/** One row of search results. */
export interface SearchHit {
  /** ``"curated"`` or ``"taginfo"``. */
  source: "curated" | "taginfo" | string;
  key: string;
  value: string | null;
  label: string | null;
  score: number;
  curated: GlossaryEntry | null;
  taginfo: Record<string, unknown> | null;
}

export interface SearchResponse {
  q: string;
  hits: SearchHit[];
}
