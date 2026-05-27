/**
 * QueryBuilder tests.
 *
 * Three pillars:
 *  1. toQL emits the canonical QL shape the backend / runOverpassQuery expects.
 *  2. tryParse round-trips every shape toQL emits, plus the legacy snippet
 *     library, and returns null for grammar the Builder can't represent.
 *  3. matchSubjects + searchSubjects produce expected results on a small
 *     fixture-derived glossary so the UI behaviour is locked in.
 *
 * The glossary fixture is a hand-trimmed subset of the live curated glossary
 * (backend/app/kml/tag_glossary.py) — kept here rather than fetched at test
 * time so the lib can be unit-tested without a backend.
 */

import { describe, expect, it } from "vitest";
import type { GlossaryEntry } from "./tagLibrary.types";
import {
  buildQuery,
  clauseToBlock,
  expandSubject,
  matchSubjects,
  parseTagFilters,
  toQL,
  tryParse,
  type FeatureBlock,
  type StructuredQuery,
} from "./queryBuilder";
import { SUBJECT_CATALOG, searchSubjects, type Subject } from "./subjectCatalog";

// ---------------------------------------------------------------------------
// Fixture glossary — subset of the live one. Covers every entry referenced
// by the subject catalog so subject expansion has all the clauses it needs.
// ---------------------------------------------------------------------------

const FIXTURE_GLOSSARY: GlossaryEntry[] = [
  // Detention
  glossary("amenity-prison", "amenity", "prison", "detention", 'nwr["amenity"="prison"]({{bbox}});'),
  glossary("building-prison", "building", "prison", "detention", 'wr["building"="prison"]({{bbox}});'),
  glossary("building-detention", "building", "detention", "detention", 'wr["building"="detention"]({{bbox}});'),
  glossary("amenity-police", "amenity", "police", "detention", 'nwr["amenity"="police"]({{bbox}});'),
  glossary("building-warehouse", "building", "warehouse", "detention", 'wr["building"="warehouse"]({{bbox}});'),

  // Mortality
  glossary("amenity-grave-yard", "amenity", "grave_yard", "mortality", 'nwr["amenity"="grave_yard"]({{bbox}});'),
  glossary("landuse-cemetery", "landuse", "cemetery", "mortality", 'wr["landuse"="cemetery"]({{bbox}});'),
  glossary("cemetery-mass-grave", "cemetery", "mass_grave", "mortality", 'wr["cemetery"="mass_grave"]({{bbox}});'),
  glossary("historic-memorial-mass-grave", "memorial", "mass_grave", "mortality", 'nwr["memorial"="mass_grave"]({{bbox}});'),
  glossary("historic-memorial", "historic", "memorial", "mortality", 'nwr["historic"="memorial"]({{bbox}});'),
  glossary("memorial-war-memorial", "memorial", "war_memorial", "mortality", 'nwr["memorial"="war_memorial"]({{bbox}});'),

  // Destruction
  glossary("damage-destroyed", "damage", "destroyed", "destruction", 'wr["damage"="destroyed"]({{bbox}});'),
  glossary("damage-damaged", "damage", "damaged", "destruction", 'wr["damage"="damaged"]({{bbox}});'),
  glossary("building-condition-damaged", "building:condition", "damaged", "destruction", 'wr["building:condition"="damaged"]({{bbox}});'),
  glossary("building-condition-destroyed", "building:condition", "destroyed", "destruction", 'wr["building:condition"="destroyed"]({{bbox}});'),
  glossary("abandoned-building", "abandoned:building", null, "destruction", 'wr["abandoned:building"]({{bbox}});'),
  glossary("ruins-yes", "ruins", "yes", "destruction", 'wr["ruins"="yes"]({{bbox}});'),

  // Military
  glossary("landuse-military", "landuse", "military", "military", 'wr["landuse"="military"]({{bbox}});'),
  glossary("military-base", "military", "base", "military", 'nwr["military"="base"]({{bbox}});'),
  glossary("military-barracks", "military", "barracks", "military", 'nwr["military"="barracks"]({{bbox}});'),
  glossary("military-checkpoint", "military", "checkpoint", "military", 'nwr["military"="checkpoint"]({{bbox}});'),
  glossary("barrier-checkpoint", "barrier", "checkpoint", "military", 'nwr["barrier"="checkpoint"]({{bbox}});'),
  glossary("barrier-border-control", "barrier", "border_control", "military", 'nwr["barrier"="border_control"]({{bbox}});'),
  glossary("military-bunker", "military", "bunker", "military", 'nwr["military"="bunker"]({{bbox}});'),
  glossary("military-trench", "military", "trench", "military", 'wr["military"="trench"]({{bbox}});'),

  // Displacement
  glossary("amenity-refugee-site", "amenity", "refugee_site", "displacement", 'nwr["amenity"="refugee_site"]({{bbox}});'),
  glossary("social-facility-refugee", "social_facility", "refugee", "displacement", 'nwr["social_facility"="refugee"]({{bbox}});'),
  glossary("amenity-shelter", "amenity", "shelter", "displacement", 'nwr["amenity"="shelter"]["shelter_type"="emergency_shelter"]({{bbox}});'),
  glossary("emergency-assembly-point", "emergency", "assembly_point", "displacement", 'nwr["emergency"="assembly_point"]({{bbox}});'),

  // Civilian
  glossary("amenity-school", "amenity", "school", "civilian", 'nwr["amenity"="school"]({{bbox}});'),
  glossary("amenity-kindergarten", "amenity", "kindergarten", "civilian", 'nwr["amenity"="kindergarten"]({{bbox}});'),
  glossary("amenity-hospital", "amenity", "hospital", "civilian", 'nwr["amenity"="hospital"]({{bbox}});'),
  glossary("healthcare-hospital", "healthcare", "hospital", "civilian", 'nwr["healthcare"="hospital"]({{bbox}});'),
  glossary("amenity-clinic", "amenity", "clinic", "civilian", 'nwr["amenity"="clinic"]({{bbox}});'),
  glossary("amenity-doctors", "amenity", "doctors", "civilian", 'nwr["amenity"="doctors"]({{bbox}});'),
  glossary("amenity-place-of-worship", "amenity", "place_of_worship", "civilian", 'nwr["amenity"="place_of_worship"]({{bbox}});'),
  glossary("amenity-marketplace", "amenity", "marketplace", "civilian", 'nwr["amenity"="marketplace"]({{bbox}});'),
  glossary("man-made-water-well", "man_made", "water_well", "civilian", 'nwr["man_made"="water_well"]({{bbox}});'),
  glossary("man-made-water-tower", "man_made", "water_tower", "civilian", 'nwr["man_made"="water_tower"]({{bbox}});'),
  glossary("amenity-drinking-water", "amenity", "drinking_water", "civilian", 'nwr["amenity"="drinking_water"]({{bbox}});'),
  glossary("amenity-university", "amenity", "university", "civilian", 'nwr["amenity"="university"]({{bbox}});'),
  glossary("amenity-library", "amenity", "library", "civilian", 'nwr["amenity"="library"]({{bbox}});'),
  glossary("historic-monument", "historic", "monument", "civilian", 'nwr["historic"="monument"]({{bbox}});'),
  glossary("historic-archaeological-site", "historic", "archaeological_site", "civilian", 'nwr["historic"="archaeological_site"]({{bbox}});'),
  glossary("aeroway-aerodrome", "aeroway", "aerodrome", "civilian", 'nwr["aeroway"="aerodrome"]({{bbox}});'),
  glossary("power-plant", "power", "plant", "civilian", 'wr["power"="plant"]({{bbox}});'),
];

function glossary(
  id: string,
  key: string,
  value: string | null,
  domain: GlossaryEntry["domain"],
  clause: string,
): GlossaryEntry {
  return {
    id,
    key,
    value,
    domain,
    label: id,
    field_note: "",
    related_tags: [],
    default_overpass_clause: clause,
    default_icon_id: null,
  };
}

// ---------------------------------------------------------------------------
// toQL
// ---------------------------------------------------------------------------

describe("toQL", () => {
  it("emits header + footer for an empty query (no-op)", () => {
    expect(toQL({ blocks: [], combine: "any" })).toBe(
      `[out:json][timeout:25];\nout body geom;`,
    );
  });

  it("emits a single statement without union wrapper", () => {
    const ql = toQL({
      blocks: [{ tags: [{ key: "amenity", op: "=", value: "prison" }] }],
      combine: "any",
    });
    expect(ql).toBe(
      `[out:json][timeout:25];\nnwr["amenity"="prison"]({{bbox}});\nout body geom;`,
    );
  });

  it("emits a union block for multiple blocks (combine=any)", () => {
    const ql = toQL({
      blocks: [
        { tags: [{ key: "amenity", op: "=", value: "hospital" }] },
        { tags: [{ key: "amenity", op: "=", value: "clinic" }] },
      ],
      combine: "any",
    });
    expect(ql).toBe(
      `[out:json][timeout:25];\n(\n  nwr["amenity"="hospital"]({{bbox}});\n  nwr["amenity"="clinic"]({{bbox}});\n);\nout body geom;`,
    );
  });

  it("chains every tag onto one statement when combine=all", () => {
    const ql = toQL({
      blocks: [
        { tags: [{ key: "amenity", op: "=", value: "prison" }] },
        { tags: [{ key: "damage", op: "=", value: "destroyed" }] },
      ],
      combine: "all",
    });
    expect(ql).toBe(
      `[out:json][timeout:25];\nnwr["amenity"="prison"]["damage"="destroyed"]({{bbox}});\nout body geom;`,
    );
  });

  it("renders the four tag operators", () => {
    const ql = toQL({
      blocks: [
        {
          tags: [
            { key: "amenity", op: "=", value: "prison" },
            { key: "name", op: "!=", value: "Old Town" },
            { key: "healthcare", op: "~", value: "hospital|clinic" },
            { key: "wikidata", op: "exists", value: "" },
            { key: "deleted", op: "not-exists", value: "" },
          ],
        },
      ],
      combine: "any",
    });
    expect(ql).toContain(`["amenity"="prison"]`);
    expect(ql).toContain(`["name"!="Old Town"]`);
    expect(ql).toContain(`["healthcare"~"hospital|clinic"]`);
    expect(ql).toContain(`["wikidata"]`);
    expect(ql).toContain(`[!"deleted"]`);
  });
});

// ---------------------------------------------------------------------------
// expandSubject + clauseToBlock
// ---------------------------------------------------------------------------

describe("clauseToBlock", () => {
  it("parses a simple glossary clause into a FeatureBlock", () => {
    const entry = FIXTURE_GLOSSARY.find((e) => e.id === "amenity-prison")!;
    const block = clauseToBlock(entry);
    expect(block).not.toBeNull();
    expect(block!.tags).toEqual([{ key: "amenity", op: "=", value: "prison" }]);
    expect(block!.sourceGlossaryEntryId).toBe("amenity-prison");
  });

  it("parses a key-only clause into an exists clause", () => {
    const entry = FIXTURE_GLOSSARY.find((e) => e.id === "abandoned-building")!;
    const block = clauseToBlock(entry);
    expect(block).not.toBeNull();
    expect(block!.tags).toEqual([
      { key: "abandoned:building", op: "exists", value: "" },
    ]);
  });

  it("parses a two-filter clause into AND-chained tags", () => {
    const entry = FIXTURE_GLOSSARY.find((e) => e.id === "amenity-shelter")!;
    const block = clauseToBlock(entry);
    expect(block).not.toBeNull();
    expect(block!.tags).toEqual([
      { key: "amenity", op: "=", value: "shelter" },
      { key: "shelter_type", op: "=", value: "emergency_shelter" },
    ]);
  });

  it("returns null for entries without a clause (evidence domain)", () => {
    const evidence: GlossaryEntry = {
      ...FIXTURE_GLOSSARY[0],
      id: "source",
      default_overpass_clause: null,
    };
    expect(clauseToBlock(evidence)).toBeNull();
  });
});

describe("expandSubject", () => {
  it("expands a single-entry subject into one block", () => {
    const subject = SUBJECT_CATALOG.find((s) => s.id === "religious-sites")!;
    const blocks = expandSubject(subject, FIXTURE_GLOSSARY);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sourceSubjectId).toBe("religious-sites");
  });

  it("expands a multi-entry subject into multiple blocks", () => {
    const subject = SUBJECT_CATALOG.find((s) => s.id === "hospitals-clinics")!;
    const blocks = expandSubject(subject, FIXTURE_GLOSSARY);
    expect(blocks.length).toBe(4); // hospital + healthcare + clinic + doctors
    for (const b of blocks) {
      expect(b.sourceSubjectId).toBe("hospitals-clinics");
    }
  });

  it("drops missing glossary entries silently", () => {
    const subject: Subject = {
      ...SUBJECT_CATALOG[0],
      id: "test",
      glossaryEntryIds: ["amenity-prison", "doesnt-exist"],
    };
    const blocks = expandSubject(subject, FIXTURE_GLOSSARY);
    expect(blocks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Every catalog subject must expand to at least one block.
// ---------------------------------------------------------------------------

describe("subject catalog integrity", () => {
  for (const subject of SUBJECT_CATALOG) {
    it(`subject "${subject.id}" expands to ≥1 block`, () => {
      const blocks = expandSubject(subject, FIXTURE_GLOSSARY);
      expect(blocks.length).toBeGreaterThan(0);
    });
  }

  it("every glossary entry referenced by the catalog exists in the fixture", () => {
    const fixtureIds = new Set(FIXTURE_GLOSSARY.map((e) => e.id));
    for (const subject of SUBJECT_CATALOG) {
      for (const id of subject.glossaryEntryIds) {
        expect(fixtureIds.has(id), `missing glossary entry: ${id}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// tryParse: round-trip + grammar bounds
// ---------------------------------------------------------------------------

describe("tryParse", () => {
  it("returns the empty query for empty input", () => {
    const out = tryParse("");
    expect(out).not.toBeNull();
    expect(out!.blocks).toEqual([]);
  });

  it("ignores line comments", () => {
    const ql = `// header comment\n[out:json][timeout:25];\nnwr["amenity"="prison"]({{bbox}});\nout body geom;`;
    const out = tryParse(ql);
    expect(out).not.toBeNull();
    expect(out!.blocks).toHaveLength(1);
  });

  it("parses a single statement", () => {
    const ql = `[out:json][timeout:25];\nnwr["amenity"="prison"]({{bbox}});\nout body geom;`;
    const out = tryParse(ql);
    expect(out).not.toBeNull();
    expect(out!.blocks).toEqual([
      { tags: [{ key: "amenity", op: "=", value: "prison" }] },
    ]);
  });

  it("parses a union block", () => {
    const ql = `[out:json][timeout:25];
(
  nwr["amenity"="hospital"]({{bbox}});
  nwr["amenity"="clinic"]({{bbox}});
);
out body geom;`;
    const out = tryParse(ql);
    expect(out).not.toBeNull();
    expect(out!.blocks).toHaveLength(2);
  });

  it("parses AND-chained tag filters", () => {
    const ql = `[out:json][timeout:25];\nnwr["amenity"="shelter"]["shelter_type"="emergency_shelter"]({{bbox}});\nout body geom;`;
    const out = tryParse(ql);
    expect(out).not.toBeNull();
    expect(out!.blocks[0].tags).toEqual([
      { key: "amenity", op: "=", value: "shelter" },
      { key: "shelter_type", op: "=", value: "emergency_shelter" },
    ]);
  });

  it("parses every tag operator", () => {
    const ql = `nwr["amenity"="prison"]["name"!="Old"]["healthcare"~"hospital|clinic"]["wikidata"][!"deleted"]({{bbox}});out body geom;`;
    const out = tryParse(ql);
    expect(out).not.toBeNull();
    expect(out!.blocks[0].tags).toEqual([
      { key: "amenity", op: "=", value: "prison" },
      { key: "name", op: "!=", value: "Old" },
      { key: "healthcare", op: "~", value: "hospital|clinic" },
      { key: "wikidata", op: "exists", value: "" },
      { key: "deleted", op: "not-exists", value: "" },
    ]);
  });

  // -- Unsupported grammar --------------------------------------------------

  it.each([
    ["around: filter", `nwr(around:500)({{bbox}});out body geom;`],
    ["named set ref", `_set.foo;out body geom;`],
    ["polygon area", `nwr(poly:"10 20 30 40");out body geom;`],
    ["recurse directive", `>;out body geom;`],
    ["non-bbox area", `nwr["amenity"="prison"](51.5,-0.2,51.6,-0.1);out body geom;`],
    ["unbalanced parens", `(nwr["amenity"="prison"]({{bbox}});out body geom;`],
  ])("returns null for unsupported: %s", (_label, ql) => {
    expect(tryParse(ql)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: every catalog subject's QL parses back to equivalent blocks.
// ---------------------------------------------------------------------------

describe("round-trip: subject → toQL → tryParse", () => {
  for (const subject of SUBJECT_CATALOG) {
    it(`"${subject.id}" round-trips`, () => {
      const blocks = expandSubject(subject, FIXTURE_GLOSSARY);
      const original: StructuredQuery = { blocks, combine: "any" };
      const ql = toQL(original);
      const parsed = tryParse(ql);
      expect(parsed).not.toBeNull();
      expect(parsed!.blocks).toHaveLength(blocks.length);
      // Compare signatures (ignoring sourceSubjectId since parsing strips it).
      for (let i = 0; i < blocks.length; i++) {
        expect(parsed!.blocks[i].tags).toEqual(blocks[i].tags);
      }
    });
  }

  it("round-trips combine=all (AND across blocks)", () => {
    const q: StructuredQuery = {
      blocks: [
        { tags: [{ key: "amenity", op: "=", value: "prison" }] },
        { tags: [{ key: "damage", op: "=", value: "destroyed" }] },
      ],
      combine: "all",
    };
    const ql = toQL(q);
    const parsed = tryParse(ql);
    expect(parsed).not.toBeNull();
    // combine=all collapses to a single statement; the parser sees one block
    // with both tags chained.
    expect(parsed!.blocks).toHaveLength(1);
    expect(parsed!.blocks[0].tags).toEqual([
      { key: "amenity", op: "=", value: "prison" },
      { key: "damage", op: "=", value: "destroyed" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// matchSubjects: round-trip recovers subject IDs.
// ---------------------------------------------------------------------------

describe("matchSubjects", () => {
  it("recovers a single subject", () => {
    const subject = SUBJECT_CATALOG.find((s) => s.id === "religious-sites")!;
    const blocks = expandSubject(subject, FIXTURE_GLOSSARY).map(stripSource);
    const result = matchSubjects(blocks, FIXTURE_GLOSSARY);
    expect(result.subjectIds).toEqual(["religious-sites"]);
    expect(result.customBlocks).toEqual([]);
  });

  it("recovers multiple subjects", () => {
    const prisons = expandSubject(
      SUBJECT_CATALOG.find((s) => s.id === "prisons-detention")!,
      FIXTURE_GLOSSARY,
    ).map(stripSource);
    const hospitals = expandSubject(
      SUBJECT_CATALOG.find((s) => s.id === "hospitals-clinics")!,
      FIXTURE_GLOSSARY,
    ).map(stripSource);
    const result = matchSubjects([...prisons, ...hospitals], FIXTURE_GLOSSARY);
    expect(result.subjectIds.sort()).toEqual(["hospitals-clinics", "prisons-detention"]);
    expect(result.customBlocks).toEqual([]);
  });

  it("emits leftover blocks as customBlocks", () => {
    const prisons = expandSubject(
      SUBJECT_CATALOG.find((s) => s.id === "prisons-detention")!,
      FIXTURE_GLOSSARY,
    ).map(stripSource);
    const random: FeatureBlock = {
      tags: [{ key: "shop", op: "=", value: "bakery" }],
    };
    const result = matchSubjects([...prisons, random], FIXTURE_GLOSSARY);
    expect(result.subjectIds).toEqual(["prisons-detention"]);
    expect(result.customBlocks).toEqual([random]);
  });
});

function stripSource(block: FeatureBlock): FeatureBlock {
  return { tags: block.tags };
}

// ---------------------------------------------------------------------------
// searchSubjects: the "jail → 🏛️ Prisons" path.
// ---------------------------------------------------------------------------

describe("searchSubjects", () => {
  it.each([
    ["jail", "prisons-detention"],
    ["jails", "prisons-detention"],
    ["prison", "prisons-detention"],
    ["lockup", "prisons-detention"],
    ["mosque", "religious-sites"],
    ["church", "religious-sites"],
    ["hospital", "hospitals-clinics"],
    ["clinic", "hospitals-clinics"],
    ["school", "schools"],
    ["kindergarten", "schools"],
    ["mass grave", "mass-graves"],
    ["cemetery", "cemeteries-graves"],
    ["destroyed", "destroyed-buildings"],
    ["damaged", "damaged-buildings"],
    ["checkpoint", "checkpoints"],
    ["refugee", "refugee-sites"],
  ])('"%s" finds subject "%s"', (q, expectedId) => {
    const hits = searchSubjects(q, FIXTURE_GLOSSARY);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].subject.id).toBe(expectedId);
  });

  it("matches fuzzy typos within 2 edit distance", () => {
    const hits = searchSubjects("prsion", FIXTURE_GLOSSARY); // missing 'i'
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].subject.id).toBe("prisons-detention");
  });

  it("matches hosptial typo", () => {
    const hits = searchSubjects("hosptial", FIXTURE_GLOSSARY);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].subject.id).toBe("hospitals-clinics");
  });

  it("matches raw OSM tag string", () => {
    const hits = searchSubjects("amenity=prison", FIXTURE_GLOSSARY);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].subject.id).toBe("prisons-detention");
  });

  it("returns empty array for nonsense", () => {
    const hits = searchSubjects("zxqvwpoiu", FIXTURE_GLOSSARY);
    expect(hits).toEqual([]);
  });

  it("returns empty array for empty query", () => {
    const hits = searchSubjects("", FIXTURE_GLOSSARY);
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildQuery: the top-level convenience.
// ---------------------------------------------------------------------------

describe("buildQuery", () => {
  it("composes subjects and custom blocks into one StructuredQuery", () => {
    const q = buildQuery({
      subjectIds: ["religious-sites"],
      customBlocks: [{ tags: [{ key: "shop", op: "exists", value: "" }] }],
      glossary: FIXTURE_GLOSSARY,
    });
    expect(q.blocks).toHaveLength(2);
    expect(q.combine).toBe("any");
  });

  it("ignores unknown subject IDs", () => {
    const q = buildQuery({
      subjectIds: ["nonexistent", "religious-sites"],
      glossary: FIXTURE_GLOSSARY,
    });
    expect(q.blocks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseTagFilters: edge cases for the lowest-level parser.
// ---------------------------------------------------------------------------

describe("parseTagFilters", () => {
  it("handles bare keys", () => {
    expect(parseTagFilters(`[wikidata]`)).toEqual([
      { key: "wikidata", op: "exists", value: "" },
    ]);
  });

  it("handles unquoted values (some snippets do this)", () => {
    expect(parseTagFilters(`[amenity=prison]`)).toEqual([
      { key: "amenity", op: "=", value: "prison" },
    ]);
  });

  it("handles values containing equals signs in regex form", () => {
    // The `~` operator's value is JSON-encoded so a regex like
    // ``hospital|clinic`` is unambiguous; this is the only safe case.
    expect(parseTagFilters(`["healthcare"~"hospital|clinic"]`)).toEqual([
      { key: "healthcare", op: "~", value: "hospital|clinic" },
    ]);
  });
});
