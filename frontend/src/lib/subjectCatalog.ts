/**
 * Subject catalog — the user-facing "kinds of place" the Query Builder shows.
 *
 * Each Subject bundles one or more curated glossary entries (from
 * ``backend/app/kml/tag_glossary.py``, fetched via
 * ``GET /api/tag-library/curated``) into a plain-English handle an
 * investigator can grok without knowing any OSM tagging conventions.
 *
 * Mapping:
 *
 *    Subject               ──maps to──►   GlossaryEntry[]
 *    "Hospitals & clinics" ──maps to──►   amenity-hospital,
 *                                         healthcare-hospital,
 *                                         amenity-clinic,
 *                                         amenity-doctors
 *
 * Subjects are the layer of editorial that turns "OSM data model" into
 * "investigator vocabulary". They expose:
 *
 *  - ``label``    — what appears on the tile / chip
 *  - ``aliases``  — the synonym vocabulary that drives fuzzy search
 *                   ("jail" → Prisons & detention; "mosque" → Religious sites)
 *  - ``description`` — one-line "what this finds" tooltip
 *  - ``icon``     — an emoji rendered on the tile (UI-only; distinct from
 *                   the glossary's ``default_icon_id`` which is the Earth
 *                   Pro icon used on the rendered map)
 *  - ``typicalResults`` — coarse expectation-setting; helps an investigator
 *                   judge whether a returned count is plausible.
 *  - ``featured`` — appears in the "Common in HR work" row at the top of
 *                   the subject picker.
 *  - ``glossaryEntryIds`` — the underlying curated entries this subject
 *                   expands to; multiple entries become a union (OR) on
 *                   query emit.
 *
 * Note: only glossary entries with a non-null ``default_overpass_clause``
 * can be bundled — the evidence-domain entries (source, fixme, note, …)
 * aren't queryable as subjects, so they're omitted here.
 */

import type { GlossaryDomain, GlossaryEntry } from "@/lib/tagLibrary.types";

export type SubjectGroup = Exclude<GlossaryDomain, "evidence">;

export interface Subject {
  id: string;
  label: string;
  icon: string;
  group: SubjectGroup;
  /** Common-vocabulary search terms. Weighted highest in the fuzzy matcher;
   *  generous coverage is intentional — better noisy aliases that return the
   *  right tile in one keystroke than precise aliases that miss. */
  aliases: string[];
  description: string;
  /** Coarse count expectation, shown in the provenance reveal. */
  typicalResults: string;
  /** When true, the subject appears in the "Common in HR work" featured row. */
  featured?: boolean;
  /** Underlying curated glossary entries (resolved by ``id``). Multiple
   *  entries → union (OR) on emit. */
  glossaryEntryIds: string[];
}

export const SUBJECT_CATALOG: Subject[] = [
  // ------------------------------------------------------------------
  // Detention
  // ------------------------------------------------------------------
  {
    id: "prisons-detention",
    label: "Prisons & detention",
    icon: "🏛️",
    group: "detention",
    aliases: [
      "jail",
      "jails",
      "prison",
      "prisons",
      "lockup",
      "lock-up",
      "detention",
      "detention center",
      "detention centre",
      "penitentiary",
      "internment",
      "holding",
      "incarceration",
      "labor camp",
      "labour camp",
      "gulag",
    ],
    description: "Formal prisons and explicit detention buildings.",
    typicalResults: "1–20 in an urban area",
    featured: true,
    glossaryEntryIds: ["amenity-prison", "building-prison", "building-detention"],
  },
  {
    id: "police-stations",
    label: "Police stations",
    icon: "🚓",
    group: "detention",
    aliases: ["police", "police station", "precinct", "cop shop", "law enforcement"],
    description: "Police stations — often hold detainees in cells without formal prison tagging.",
    typicalResults: "5–50 in a city",
    glossaryEntryIds: ["amenity-police"],
  },
  {
    id: "warehouse-cross-ref",
    label: "Warehouses (cross-reference)",
    icon: "🏭",
    group: "detention",
    aliases: ["warehouse", "warehouses", "depot", "storage"],
    description:
      "Plain warehouses — used in Browse mode for spatial cross-referencing against military land. Not a primary detention indicator on its own.",
    typicalResults: "Dozens to hundreds",
    glossaryEntryIds: ["building-warehouse"],
  },

  // ------------------------------------------------------------------
  // Mortality
  // ------------------------------------------------------------------
  {
    id: "cemeteries-graves",
    label: "Cemeteries & graves",
    icon: "⚰️",
    group: "mortality",
    aliases: [
      "cemetery",
      "cemeteries",
      "graveyard",
      "graveyards",
      "grave",
      "graves",
      "burial",
      "burial ground",
      "tomb",
      "tombs",
    ],
    description: "Cemeteries and small graveyards. Pair with mass-grave subjects for atrocity context.",
    typicalResults: "0–10 in a typical region",
    featured: true,
    glossaryEntryIds: ["amenity-grave-yard", "landuse-cemetery"],
  },
  {
    id: "mass-graves",
    label: "Mass graves",
    icon: "🪦",
    group: "mortality",
    aliases: [
      "mass grave",
      "mass graves",
      "mass burial",
      "execution site",
      "killing field",
    ],
    description:
      "OSM features explicitly tagged as mass graves (sub-tag of cemeteries, plus historic memorial markers).",
    typicalResults: "Rare — usually 0 unless investigation is active",
    featured: true,
    glossaryEntryIds: ["cemetery-mass-grave", "historic-memorial-mass-grave"],
  },
  {
    id: "memorials",
    label: "Memorials",
    icon: "🕯️",
    group: "mortality",
    aliases: ["memorial", "memorials", "monument to victims", "commemoration"],
    description: "Memorial sites — war memorials, plaques, monuments commemorating events.",
    typicalResults: "1–30 in a region",
    glossaryEntryIds: ["historic-memorial", "memorial-war-memorial"],
  },

  // ------------------------------------------------------------------
  // Destruction
  // ------------------------------------------------------------------
  {
    id: "destroyed-buildings",
    label: "Destroyed buildings",
    icon: "💥",
    group: "destruction",
    aliases: [
      "destroyed",
      "destruction",
      "shelled",
      "bombed",
      "leveled",
      "razed",
      "destroyed building",
    ],
    description: "Buildings tagged as fully destroyed under either common OSM convention.",
    typicalResults: "0–thousands depending on conflict intensity",
    featured: true,
    glossaryEntryIds: ["damage-destroyed", "building-condition-destroyed"],
  },
  {
    id: "damaged-buildings",
    label: "Damaged buildings",
    icon: "🏚️",
    group: "destruction",
    aliases: [
      "damaged",
      "damage",
      "partially destroyed",
      "shelled",
      "damaged building",
    ],
    description: "Buildings tagged as partially damaged. Less reliable than 'destroyed' — read notes.",
    typicalResults: "0–thousands in active conflict",
    glossaryEntryIds: ["damage-damaged", "building-condition-damaged"],
  },
  {
    id: "ruins-abandoned",
    label: "Ruins & abandoned structures",
    icon: "🏗️",
    group: "destruction",
    aliases: ["ruins", "ruin", "abandoned", "derelict", "deserted"],
    description: "Ruined or abandoned structures. Mind historical vs. recent destruction.",
    typicalResults: "Tens to hundreds",
    glossaryEntryIds: ["abandoned-building", "ruins-yes"],
  },

  // ------------------------------------------------------------------
  // Military
  // ------------------------------------------------------------------
  {
    id: "military-sites",
    label: "Military sites",
    icon: "⛔",
    group: "military",
    aliases: [
      "military",
      "army",
      "base",
      "bases",
      "barracks",
      "garrison",
      "fortification",
      "post",
    ],
    description: "Military land, bases, and barracks — formally designated areas.",
    typicalResults: "1–20 in a region",
    featured: true,
    glossaryEntryIds: ["landuse-military", "military-base", "military-barracks"],
  },
  {
    id: "checkpoints",
    label: "Checkpoints",
    icon: "🚧",
    group: "military",
    aliases: [
      "checkpoint",
      "checkpoints",
      "border crossing",
      "border control",
      "roadblock",
    ],
    description: "Formal checkpoints — military, civilian, and border controls.",
    typicalResults: "0–50 along a contested route",
    glossaryEntryIds: [
      "military-checkpoint",
      "barrier-checkpoint",
      "barrier-border-control",
    ],
  },
  {
    id: "fortifications",
    label: "Fortifications",
    icon: "🏰",
    group: "military",
    aliases: ["bunker", "bunkers", "trench", "trenches", "fortification", "fort"],
    description: "Hardened defensive structures and earthworks. Often OSINT-mapped.",
    typicalResults: "0–100 in a contested front-line region",
    glossaryEntryIds: ["military-bunker", "military-trench"],
  },

  // ------------------------------------------------------------------
  // Displacement
  // ------------------------------------------------------------------
  {
    id: "refugee-sites",
    label: "Refugee & IDP sites",
    icon: "⛺",
    group: "displacement",
    aliases: [
      "refugee",
      "refugees",
      "idp",
      "displaced",
      "displacement",
      "camp",
      "refugee camp",
      "idp camp",
    ],
    description: "Refugee and IDP camps, plus the social facilities that service them.",
    typicalResults: "0–20 in an affected region",
    featured: true,
    glossaryEntryIds: ["amenity-refugee-site", "social-facility-refugee"],
  },
  {
    id: "emergency-shelters",
    label: "Emergency shelters",
    icon: "🆘",
    group: "displacement",
    aliases: [
      "shelter",
      "shelters",
      "emergency shelter",
      "evacuation",
      "assembly point",
    ],
    description: "Emergency shelters and evacuation assembly points.",
    typicalResults: "0–30 in an affected region",
    glossaryEntryIds: ["amenity-shelter", "emergency-assembly-point"],
  },

  // ------------------------------------------------------------------
  // Civilian (protected infrastructure)
  // ------------------------------------------------------------------
  {
    id: "schools",
    label: "Schools",
    icon: "🏫",
    group: "civilian",
    aliases: [
      "school",
      "schools",
      "kindergarten",
      "kindergarden",
      "preschool",
      "daycare",
      "day care",
      "university",
      "universities",
      "college",
      "education",
      "primary",
      "secondary",
      "madrasa",
      "yeshiva",
    ],
    description: "Schools, kindergartens, and universities — protected under IHL.",
    typicalResults: "Dozens in a city",
    featured: true,
    glossaryEntryIds: ["amenity-school", "amenity-kindergarten", "amenity-university"],
  },
  {
    id: "hospitals-clinics",
    label: "Hospitals & clinics",
    icon: "🏥",
    group: "civilian",
    aliases: [
      "hospital",
      "hospitals",
      "clinic",
      "clinics",
      "medical",
      "doctor",
      "doctors",
      "healthcare",
      "health care",
      "infirmary",
      "trauma",
      "emergency room",
      "er",
    ],
    description: "Medical facilities under both common OSM conventions.",
    typicalResults: "5–40 in a city-sized area",
    featured: true,
    glossaryEntryIds: [
      "amenity-hospital",
      "healthcare-hospital",
      "amenity-clinic",
      "amenity-doctors",
    ],
  },
  {
    id: "religious-sites",
    label: "Religious sites",
    icon: "⛪",
    group: "civilian",
    aliases: [
      "church",
      "churches",
      "mosque",
      "mosques",
      "synagogue",
      "synagogues",
      "temple",
      "temples",
      "shrine",
      "shrines",
      "place of worship",
      "religious",
      "worship",
      "cathedral",
      "chapel",
      "monastery",
      "convent",
    ],
    description: "Places of worship across all denominations — protected under IHL/Hague.",
    typicalResults: "Dozens to hundreds in a settled area",
    featured: true,
    glossaryEntryIds: ["amenity-place-of-worship"],
  },
  {
    id: "water-infrastructure",
    label: "Water infrastructure",
    icon: "💧",
    group: "civilian",
    aliases: [
      "water",
      "well",
      "wells",
      "water well",
      "water tower",
      "drinking water",
      "reservoir",
    ],
    description: "Wells, water towers, and drinking-water points — protected under AP I Art. 54.",
    typicalResults: "Tens in an urban area",
    glossaryEntryIds: ["man-made-water-well", "man-made-water-tower", "amenity-drinking-water"],
  },
  {
    id: "cultural-heritage",
    label: "Cultural heritage",
    icon: "🏛",
    group: "civilian",
    aliases: [
      "monument",
      "monuments",
      "library",
      "libraries",
      "archaeological",
      "archaeology",
      "heritage",
      "historic",
      "historical",
    ],
    description: "Libraries, monuments, archaeological sites — Hague Convention 1954 protections.",
    typicalResults: "5–50 in a heritage-rich area",
    glossaryEntryIds: [
      "amenity-library",
      "historic-monument",
      "historic-archaeological-site",
    ],
  },
  {
    id: "marketplaces",
    label: "Marketplaces",
    icon: "🛒",
    group: "civilian",
    aliases: ["market", "markets", "bazaar", "marketplace", "souk"],
    description: "Civilian gathering sites — recurringly targeted in indiscriminate attacks.",
    typicalResults: "1–20 in a city",
    glossaryEntryIds: ["amenity-marketplace"],
  },
  {
    id: "airports-aerodromes",
    label: "Airports & aerodromes",
    icon: "✈️",
    group: "civilian",
    aliases: ["airport", "airports", "aerodrome", "airfield", "runway"],
    description:
      "Civilian airports — dual-use. Read aerodrome= and military= sub-tags before drawing conclusions.",
    typicalResults: "1–5 in a region",
    glossaryEntryIds: ["aeroway-aerodrome"],
  },
  {
    id: "power-infrastructure",
    label: "Power infrastructure",
    icon: "⚡",
    group: "civilian",
    aliases: ["power", "power plant", "energy", "electricity", "substation", "grid"],
    description:
      "Power plants and energy infrastructure. AP I Art. 56 specifically protects nuclear/dangerous-forces installations.",
    typicalResults: "0–20 in a region",
    glossaryEntryIds: ["power-plant"],
  },
];

// ---------------------------------------------------------------------------
// Seed scenarios — pre-selected subject bundles for the empty state.
// ---------------------------------------------------------------------------

export interface SeedScenario {
  id: string;
  label: string;
  description: string;
  subjectIds: string[];
}

export const SEED_SCENARIOS: SeedScenario[] = [
  {
    id: "detention",
    label: "Detention sites",
    description: "Prisons, police stations, and military areas — common cross-references.",
    subjectIds: ["prisons-detention", "police-stations", "military-sites"],
  },
  {
    id: "civilian-infrastructure",
    label: "Civilian infrastructure",
    description: "Schools, hospitals, water — the protected-category core.",
    subjectIds: ["schools", "hospitals-clinics", "water-infrastructure"],
  },
  {
    id: "destruction",
    label: "Destruction survey",
    description: "Destroyed and damaged buildings, ruins — for HOTOSM-style mapping.",
    subjectIds: ["destroyed-buildings", "damaged-buildings", "ruins-abandoned"],
  },
  {
    id: "cultural-heritage",
    label: "Cultural & religious heritage",
    description: "Places of worship, cemeteries, monuments, libraries.",
    subjectIds: [
      "religious-sites",
      "cemeteries-graves",
      "cultural-heritage",
      "memorials",
    ],
  },
];

// ---------------------------------------------------------------------------
// Search — fuzzy matcher over labels, aliases, descriptions, and the
// computed tag strings of the underlying glossary entries.
// ---------------------------------------------------------------------------

export interface SubjectSearchHit {
  subject: Subject;
  score: number;
  /** Which field caused the match (for highlighting in the UI). */
  matchedField: "label" | "alias" | "tag" | "description" | "group";
  /** The exact substring that matched, for bold highlighting. */
  matchedText: string;
}

const FIELD_WEIGHTS: Record<SubjectSearchHit["matchedField"], number> = {
  alias: 1.0,
  label: 0.9,
  tag: 0.5,
  description: 0.3,
  group: 0.2,
};

/** Search subjects by user-typed text. Returns hits sorted by score
 *  (highest first), then by catalog order.
 *
 *  Matching strategy (per subject):
 *   1. Exact match on label or any alias → score = weight × 2 (boosted)
 *   2. Prefix or substring match on the same → score = weight × 1
 *   3. Levenshtein distance ≤ 2 on alias / label → score = weight × 0.6
 *
 *  ``tag`` matches use the underlying glossary entries' "key=value"
 *  strings — so an investigator who types "amenity=prison" still lands on
 *  Prisons & detention.
 */
export function searchSubjects(
  query: string,
  glossary: readonly GlossaryEntry[],
  catalog: readonly Subject[] = SUBJECT_CATALOG,
  limit = 8,
): SubjectSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  // Precompute glossary entry strings keyed by id.
  const entryById = new Map(glossary.map((e) => [e.id, e]));

  const hits: SubjectSearchHit[] = [];

  for (const subject of catalog) {
    let bestHit: SubjectSearchHit | null = null;

    // Aliases (and label-as-alias)
    const labelLower = subject.label.toLowerCase();
    const aliasPool = [
      { text: labelLower, field: "label" as const },
      ...subject.aliases.map((a) => ({ text: a.toLowerCase(), field: "alias" as const })),
    ];

    for (const { text, field } of aliasPool) {
      const score = scoreMatch(q, text);
      if (score > 0) {
        const weighted = score * FIELD_WEIGHTS[field];
        if (!bestHit || weighted > bestHit.score) {
          bestHit = {
            subject,
            score: weighted,
            matchedField: field,
            matchedText: text,
          };
        }
      }
    }

    // Tag strings — "amenity=prison", "amenity=clinic", …
    for (const id of subject.glossaryEntryIds) {
      const entry = entryById.get(id);
      if (!entry) continue;
      const tagStr = entry.value
        ? `${entry.key}=${entry.value}`.toLowerCase()
        : entry.key.toLowerCase();
      const score = scoreMatch(q, tagStr);
      if (score > 0) {
        const weighted = score * FIELD_WEIGHTS.tag;
        if (!bestHit || weighted > bestHit.score) {
          bestHit = {
            subject,
            score: weighted,
            matchedField: "tag",
            matchedText: tagStr,
          };
        }
      }
    }

    // Description
    const descLower = subject.description.toLowerCase();
    const descScore = scoreMatch(q, descLower);
    if (descScore > 0) {
      const weighted = descScore * FIELD_WEIGHTS.description;
      if (!bestHit || weighted > bestHit.score) {
        bestHit = {
          subject,
          score: weighted,
          matchedField: "description",
          matchedText: descLower,
        };
      }
    }

    // Group
    const groupLower = subject.group.toLowerCase();
    const groupScore = scoreMatch(q, groupLower);
    if (groupScore > 0) {
      const weighted = groupScore * FIELD_WEIGHTS.group;
      if (!bestHit || weighted > bestHit.score) {
        bestHit = {
          subject,
          score: weighted,
          matchedField: "group",
          matchedText: groupLower,
        };
      }
    }

    if (bestHit) hits.push(bestHit);
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Match-strength score, 0–2:
 *   2 = exact match
 *   1 = substring match (prefix beats mid-string)
 *   0.6 = fuzzy match (Levenshtein distance ≤ 2 on token-of-length-≥4)
 *   0 = no match
 */
function scoreMatch(q: string, field: string): number {
  if (field === q) return 2;
  if (field.startsWith(q)) return 1.4;
  if (field.includes(q)) return 1;

  // Fuzzy: only for tokens long enough to make distance-2 meaningful, and
  // only when the candidate is roughly the same length as the query (so a
  // 3-char typo doesn't match a 30-char description).
  if (q.length >= 4 && Math.abs(field.length - q.length) <= 3) {
    if (levenshteinAtMost(q, field, 2)) return 0.6;
  }

  // Token-level fuzzy: check every word in the field.
  if (q.length >= 4) {
    for (const token of field.split(/[\s_-]+/)) {
      if (token.length >= 4 && Math.abs(token.length - q.length) <= 2) {
        if (levenshteinAtMost(q, token, 2)) return 0.5;
      }
    }
  }

  return 0;
}

/** Levenshtein distance computed with an early-exit cap, so we don't fill an
 * NxM table when we only care whether distance ≤ ``max``. Returns true if
 * the distance is at most ``max``.
 */
function levenshteinAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m <= max;
  if (m === 0) return n <= max;

  // Rolling two-row DP.
  let prev = new Array(m + 1).fill(0).map((_, i) => i);
  let curr = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,         // deletion
        curr[j - 1] + 1,     // insertion
        prev[j - 1] + cost,  // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return false;
    [prev, curr] = [curr, prev];
  }
  return prev[m] <= max;
}

// ---------------------------------------------------------------------------
// Group ordering for the picker UI.
// ---------------------------------------------------------------------------

export const SUBJECT_GROUP_ORDER: SubjectGroup[] = [
  "detention",
  "civilian",
  "destruction",
  "mortality",
  "military",
  "displacement",
];

export const SUBJECT_GROUP_LABELS: Record<SubjectGroup, string> = {
  detention: "Detention",
  mortality: "Graves & memorials",
  destruction: "Damage & destruction",
  military: "Military",
  displacement: "Refugees & shelter",
  civilian: "Civilian infrastructure",
};

export function subjectsByGroup(catalog: readonly Subject[] = SUBJECT_CATALOG): Record<SubjectGroup, Subject[]> {
  const out: Record<SubjectGroup, Subject[]> = {
    detention: [],
    mortality: [],
    destruction: [],
    military: [],
    displacement: [],
    civilian: [],
  };
  for (const s of catalog) out[s.group].push(s);
  return out;
}

export function featuredSubjects(catalog: readonly Subject[] = SUBJECT_CATALOG): Subject[] {
  return catalog.filter((s) => s.featured);
}
