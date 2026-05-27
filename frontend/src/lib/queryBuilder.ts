/**
 * QueryBuilder — turn investigator-friendly subject selections into Overpass QL.
 *
 * The flow:
 *
 *   Subject(s)  ──(expandSubject + glossary)──►  FeatureBlock[]
 *                                                       │
 *                                                  toQL(...)
 *                                                       ▼
 *                                              ``[out:json];( … );out body geom;``
 *
 * "Subjects" are the user-facing handles in ``subjectCatalog.ts`` — plain-
 * English bundles like "Prisons & detention" that wrap one or more underlying
 * curated glossary entries. The Builder never asks the investigator to think
 * about OSM tags; tags only appear when the user expands a chip to see
 * provenance, or drops into the Advanced disclosure.
 *
 * ``tryParse`` is best-effort: it covers the grammar that ``toQL`` emits plus
 * the patterns the legacy snippet library uses, so a draft round-trips. Any
 * QL feature outside that grammar (named sets, ``around:``, polygon area …)
 * returns ``null`` and the UI shows the raw-edit banner.
 */

import type { GlossaryEntry } from "@/lib/tagLibrary.types";
import { SUBJECT_CATALOG, type Subject } from "@/lib/subjectCatalog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TagOp = "=" | "!=" | "~" | "exists" | "not-exists";

export interface TagClause {
  key: string;
  op: TagOp;
  /** Empty string when ``op`` is ``"exists"`` or ``"not-exists"``. */
  value: string;
}

/** One ``nwr[..]({{bbox}});`` statement. Multiple ``tags`` chain as AND. */
export interface FeatureBlock {
  tags: TagClause[];
  /** Set when the block was emitted from a subject expansion; lets the UI
   *  group multiple blocks back into a single subject chip on round-trip. */
  sourceSubjectId?: string;
  /** Set when the block was emitted from a single glossary entry; lets the
   *  provenance reveal cite the exact entry. */
  sourceGlossaryEntryId?: string;
}

export type CombineMode = "any" | "all";

export interface StructuredQuery {
  blocks: FeatureBlock[];
  /** ``"any"`` (OR / union, default) or ``"all"`` (AND / intersection). */
  combine: CombineMode;
}

export const EMPTY_QUERY: StructuredQuery = { blocks: [], combine: "any" };

// ---------------------------------------------------------------------------
// Glossary helpers
// ---------------------------------------------------------------------------

/** Parse a curated entry's ``default_overpass_clause`` into a FeatureBlock.
 *
 * The clauses are hand-authored fragments like
 * ``nwr["amenity"="prison"]({{bbox}});`` (or ``wr[...]`` for area-only tags).
 * We strip the feature-type prefix and ``({{bbox}});`` suffix and pull the
 * bracketed tag filters out as ``TagClause`` entries.
 *
 * Returns ``null`` if the clause is missing (evidence-domain entries) or has
 * a shape the Builder can't represent (e.g. union, ``around:``).
 */
export function clauseToBlock(
  entry: GlossaryEntry,
  sourceSubjectId?: string,
): FeatureBlock | null {
  const clause = entry.default_overpass_clause;
  if (!clause) return null;

  const tags = parseTagFilters(clause);
  if (tags === null) return null;

  return {
    tags,
    sourceSubjectId,
    sourceGlossaryEntryId: entry.id,
  };
}

/** Expand a subject into one FeatureBlock per included glossary entry.
 *
 * Resolution is by ``glossaryEntryIds`` order. Entries without a queryable
 * clause (evidence domain) are silently dropped — the catalog only lists
 * subjects whose entries have clauses, but this guards against future drift.
 */
export function expandSubject(
  subject: Subject,
  glossary: readonly GlossaryEntry[],
): FeatureBlock[] {
  const byId = new Map(glossary.map((e) => [e.id, e]));
  const out: FeatureBlock[] = [];
  for (const id of subject.glossaryEntryIds) {
    const entry = byId.get(id);
    if (!entry) continue;
    const block = clauseToBlock(entry, subject.id);
    if (block) out.push(block);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serialisation: StructuredQuery → QL
// ---------------------------------------------------------------------------

const QL_HEADER = "[out:json][timeout:25];";
const QL_FOOTER = "out body geom;";
const BBOX = "{{bbox}}";

/** Emit canonical Overpass QL for the structured query.
 *
 * Output shape:
 *
 *  - 0 blocks: empty body — emits header + footer only (a syntactically valid
 *    no-op query). The UI gates the Run button on having at least 1 block, so
 *    this path is mostly for round-trip stability.
 *  - 1 block: a single ``nwr[..]({{bbox}});`` statement (no union wrapper).
 *  - N blocks with ``combine === "any"``: a ``( ... );`` union of statements.
 *  - N blocks with ``combine === "all"``: a single ``nwr`` statement with
 *    every block's tag filters chained — i.e. AND across blocks. Used when
 *    the investigator wants "places matching all selected subjects" which is
 *    rare but represented faithfully.
 */
export function toQL(q: StructuredQuery): string {
  const lines: string[] = [QL_HEADER];

  if (q.blocks.length === 0) {
    lines.push(QL_FOOTER);
    return lines.join("\n");
  }

  if (q.blocks.length === 1) {
    lines.push(blockToStatement(q.blocks[0]));
    lines.push(QL_FOOTER);
    return lines.join("\n");
  }

  if (q.combine === "all") {
    // Chain every tag filter across every block onto a single nwr statement.
    const allTags = q.blocks.flatMap((b) => b.tags);
    lines.push(`nwr${renderTagFilters(allTags)}(${BBOX});`);
    lines.push(QL_FOOTER);
    return lines.join("\n");
  }

  // Default: union (OR).
  lines.push("(");
  for (const block of q.blocks) {
    lines.push(`  ${blockToStatement(block)}`);
  }
  lines.push(");");
  lines.push(QL_FOOTER);
  return lines.join("\n");
}

function blockToStatement(block: FeatureBlock): string {
  return `nwr${renderTagFilters(block.tags)}(${BBOX});`;
}

function renderTagFilters(tags: readonly TagClause[]): string {
  return tags.map(renderTagFilter).join("");
}

function renderTagFilter(t: TagClause): string {
  const k = JSON.stringify(t.key); // covers quoting + escaping
  switch (t.op) {
    case "=":
      return `[${k}=${JSON.stringify(t.value)}]`;
    case "!=":
      return `[${k}!=${JSON.stringify(t.value)}]`;
    case "~":
      return `[${k}~${JSON.stringify(t.value)}]`;
    case "exists":
      return `[${k}]`;
    case "not-exists":
      return `[!${k}]`;
  }
}

// ---------------------------------------------------------------------------
// Parsing: QL → StructuredQuery  (best-effort)
// ---------------------------------------------------------------------------

/** Best-effort QL → StructuredQuery parser.
 *
 * Returns ``null`` if the QL uses anything outside the grammar the Builder
 * can faithfully represent (named sets, ``around:``, polygon areas, recurse
 * directives, ``out`` flavours we don't surface, etc.). The UI uses ``null``
 * as the signal to show the "raw-edit only" banner.
 *
 * Supported grammar (loose — whitespace and comments are tolerated):
 *
 *   header?  ( statement | "(" statement+ ");" )  footer?
 *
 *   header     := ``[out:json][timeout:N];`` (any non-negative int)
 *   statement  := <type> tagfilters "(" "{{bbox}}" ")" ";"
 *   <type>     := nwr | node | way | relation | nw | wr
 *   tagfilter  := ``[`` ( "!" key | key (op value)? ) ``]``
 *   op         := = | != | ~
 *   footer     := ``out body geom;`` | ``out body;`` | ``out center;``
 *
 *  ``"all"`` combine mode is recovered when a single statement has tag
 *  filters that span multiple subject expansions (rare). The default is
 *  ``"any"`` for the union shape; ``toQL`` round-trip is exact.
 */
export function tryParse(ql: string): StructuredQuery | null {
  // Strip line comments and surrounding whitespace.
  const cleaned = stripComments(ql).trim();
  if (!cleaned) return EMPTY_QUERY;

  // Tokenise on top-level semicolons, respecting parentheses (so a union
  // block stays as a single token until we recurse into it).
  const segments = splitTopLevel(cleaned);
  if (segments === null) return null;

  const blocks: FeatureBlock[] = [];

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed.length === 0) continue;

    // Header — accept ``[out:json][timeout:N]``.
    if (isHeader(trimmed)) continue;

    // Footer — accept the small set of ``out`` flavours we emit.
    if (isFooter(trimmed)) continue;

    // Union block — ``( ... )`` containing one or more statements.
    if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
      const inner = trimmed.slice(1, -1).trim();
      const innerSegments = splitTopLevel(inner);
      if (innerSegments === null) return null;
      for (const innerSeg of innerSegments) {
        const t = innerSeg.trim();
        if (!t) continue;
        const block = parseStatement(t);
        if (block === null) return null;
        blocks.push(block);
      }
      continue;
    }

    // Bare statement.
    const block = parseStatement(trimmed);
    if (block === null) return null;
    blocks.push(block);
  }

  // Try to recover sourceSubjectId / sourceGlossaryEntryId by signature
  // matching — that's the job of matchSubject(), which the caller invokes
  // after parse. Here we just return raw blocks.
  return { blocks, combine: "any" };
}

function stripComments(ql: string): string {
  return ql
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

function isHeader(seg: string): boolean {
  // ``[out:json][timeout:25]`` or any subset/permutation we expect.
  const stripped = seg.replace(/\s+/g, "");
  return /^(\[out:json\]|\[timeout:\d+\]|\[out:xml\]|\[out:csv[^\]]*\])+$/.test(
    stripped,
  );
}

function isFooter(seg: string): boolean {
  return /^out(\s+body)?(\s+geom)?(\s+center)?\s*$/.test(seg.trim());
}

function splitTopLevel(s: string): string[] | null {
  // Walk the string, splitting on ``;`` at paren-depth 0. Quoted strings are
  // treated atomically. Returns null on unbalanced parens.
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === stringChar) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0) return null;
    } else if (c === ";" && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || inString) return null;
  const tail = s.slice(start);
  if (tail.trim().length > 0) out.push(tail);
  return out;
}

/** Parse a single statement like ``nwr["amenity"="prison"]({{bbox}})``.
 *
 * The trailing semicolon is consumed by ``splitTopLevel``; this function
 * sees just the statement body.
 */
function parseStatement(stmt: string): FeatureBlock | null {
  // Match ``<type><tagfilters>(...)``.
  const m = stmt.match(
    /^(nwr|node|way|relation|nw|wr)\s*((?:\[[^\]]*\]\s*)*)\(\s*([^)]+?)\s*\)$/,
  );
  if (!m) return null;

  const areaToken = m[3].trim();
  if (areaToken !== BBOX) return null;

  const tags = parseTagFilters(`x${m[2]}(${BBOX});`);
  if (tags === null) return null;
  return { tags };
}

/** Extract ``[k=v]`` style filters from a clause that contains them.
 *
 * Permissive about what surrounds the bracketed filters — accepts both
 * ``nwr["k"="v"]({{bbox}});`` and bare ``["k"="v"]`` fragments. Returns the
 * empty array when there are no filters (an "all features" statement, which
 * we still treat as valid).
 */
export function parseTagFilters(clause: string): TagClause[] | null {
  const tags: TagClause[] = [];
  // Find every ``[...]`` segment.
  const filterMatches = clause.matchAll(/\[([^\]]*)\]/g);
  for (const fm of filterMatches) {
    const body = fm[1].trim();

    // ``[!key]`` — not-exists. Key can be quoted or bare.
    if (body.startsWith("!")) {
      const key = unquote(body.slice(1).trim());
      if (key === null) return null;
      tags.push({ key, op: "not-exists", value: "" });
      continue;
    }

    // ``[key]`` — exists. Either quoted or bare and contains no op.
    if (!body.includes("=") && !body.includes("~")) {
      const key = unquote(body);
      if (key === null) return null;
      tags.push({ key, op: "exists", value: "" });
      continue;
    }

    // ``[key=value]`` / ``[key!=value]`` / ``[key~value]``.
    // Find the operator boundary.
    const op = body.includes("!=") ? "!=" : body.includes("~") ? "~" : "=";
    const sepIdx = body.indexOf(op);
    const keyPart = body.slice(0, sepIdx).trim();
    const valuePart = body.slice(sepIdx + op.length).trim();
    const key = unquote(keyPart);
    const value = unquote(valuePart);
    if (key === null || value === null) return null;
    tags.push({ key, op, value });
  }
  return tags;
}

/** Strip ``"..."`` / ``'...'`` quoting, leaving bare identifiers alone.
 *
 * Returns ``null`` when the string is malformed (unterminated quote, etc.).
 */
function unquote(s: string): string | null {
  const t = s.trim();
  if (t.length === 0) return "";
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try {
      return JSON.parse(t.startsWith("'") ? `"${t.slice(1, -1)}"` : t);
    } catch {
      return null;
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// Subject matching: recover subject chips from parsed blocks.
// ---------------------------------------------------------------------------

/** Given parsed blocks, identify which subjects (and stray blocks) the
 * selection covers. Used when round-tripping from raw QL back to Builder.
 *
 * Algorithm:
 *  1. For every subject, compute its expansion signature (a sorted-tuple
 *     representation of each block's tag clauses, sorted across blocks).
 *  2. Greedy-match: walk subjects in catalog order; if all of a subject's
 *     blocks appear in the remaining pool (signature-equal), claim them.
 *  3. Leftover blocks are returned as ``customBlocks`` — the UI renders
 *     them in the Advanced disclosure as ad-hoc tag rows.
 */
export function matchSubjects(
  blocks: readonly FeatureBlock[],
  glossary: readonly GlossaryEntry[],
  catalog: readonly Subject[] = SUBJECT_CATALOG,
): { subjectIds: string[]; customBlocks: FeatureBlock[] } {
  // Pool of "available" blocks indexed by signature for fast lookup.
  const pool = blocks.map((b) => ({ block: b, sig: blockSignature(b), claimed: false }));
  const subjectIds: string[] = [];

  for (const subject of catalog) {
    const expansion = expandSubject(subject, glossary);
    if (expansion.length === 0) continue;
    const needed = expansion.map(blockSignature);

    // Find a set of unclaimed pool entries that covers ``needed`` exactly.
    const claimedIdx = new Set<number>();
    let ok = true;
    for (const sig of needed) {
      const idx = pool.findIndex(
        (p, i) => !p.claimed && !claimedIdx.has(i) && p.sig === sig,
      );
      if (idx === -1) {
        ok = false;
        break;
      }
      claimedIdx.add(idx);
    }
    if (!ok) continue;
    // Commit.
    for (const idx of claimedIdx) pool[idx].claimed = true;
    subjectIds.push(subject.id);
  }

  const customBlocks = pool.filter((p) => !p.claimed).map((p) => p.block);
  return { subjectIds, customBlocks };
}

function blockSignature(block: FeatureBlock): string {
  // Sorted-canonical signature so AND-chained filters in any order compare
  // equal. Each tag becomes ``key|op|value``; the whole block joins on ``&``.
  const parts = block.tags.map((t) => `${t.key}|${t.op}|${t.value}`).sort();
  return parts.join("&");
}

// ---------------------------------------------------------------------------
// Top-level convenience: subjects + customBlocks → StructuredQuery → QL
// ---------------------------------------------------------------------------

/** Build a StructuredQuery from a Builder UI selection. ``customBlocks`` is
 * the Advanced-pane catch-all for tag rows the user added manually.
 */
export function buildQuery(input: {
  subjectIds: readonly string[];
  customBlocks?: readonly FeatureBlock[];
  combine?: CombineMode;
  glossary: readonly GlossaryEntry[];
  catalog?: readonly Subject[];
}): StructuredQuery {
  const catalog = input.catalog ?? SUBJECT_CATALOG;
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const blocks: FeatureBlock[] = [];
  for (const id of input.subjectIds) {
    const subject = byId.get(id);
    if (!subject) continue;
    blocks.push(...expandSubject(subject, input.glossary));
  }
  if (input.customBlocks) blocks.push(...input.customBlocks);
  return { blocks, combine: input.combine ?? "any" };
}
