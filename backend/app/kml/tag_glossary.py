"""Curated atrocity-investigation tag glossary.

Hand-written, lives in code, no network. Surfaced by the Tag Library drawer
alongside Taginfo metadata so investigators can decide *which* OSM key/value
pair to query without leaving the tool.

Each entry is opinionated — the ``field_note`` is the gold here, distilling
editorial guidance that goes beyond what the OSM wiki tells you. Notes are
written from a position of domain awareness: precise, never sensationalist,
focused on the operational realities of mapping atrocity evidence (e.g. how a
tag tends to be mis- or under-used in conflict zones, what to cross-reference
when the primary tag is missing, and which OSM idioms to trust).

The seven domains correspond to the bundled atrocity icon palette:

* ``detention``     formal + repurposed detention infrastructure
* ``mortality``     graves, cemeteries, mass graves, memorials
* ``destruction``   damaged or destroyed structures
* ``military``      formally designated military presence
* ``displacement``  refugee / IDP camps and informal shelter
* ``civilian``      protected civilian infrastructure (schools, hospitals, …)
* ``evidence``      OSM-side editorial / verification workflow

Helpers
-------
* :func:`all_entries` — iterate the full glossary in declaration order.
* :func:`find` — look up entries by key (and optionally value).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

Domain = Literal[
    "detention",
    "mortality",
    "destruction",
    "military",
    "displacement",
    "civilian",
    "evidence",
]


@dataclass(frozen=True)
class GlossaryEntry:
    """A single curated OSM tag entry.

    Attributes
    ----------
    id
        Stable slug identifier (unique across the glossary). Used by the
        frontend to key React lists and persist user-pinned entries.
    key
        OSM tag key, e.g. ``"amenity"``.
    value
        OSM tag value, e.g. ``"prison"``. ``None`` for wildcard entries
        (``key=*``) where the presence of the key is itself the signal.
    domain
        One of the seven atrocity-investigation domains (see module docstring).
    label
        Human-readable short label rendered in the drawer ("Prison").
    field_note
        1–2 sentences of editorial context. The whole point of this glossary.
    related_tags
        Other ``key=value`` pairs an investigator should consider when this
        one is present — or when it is suspiciously absent.
    default_overpass_clause
        A short Overpass QL fragment the UI can pre-fill (no settings line,
        no ``out`` statement — the query composer wraps that).
    default_icon_id
        Suggested icon id from :mod:`app.kml.icons`. May be ``None`` for
        entries that aren't normally rendered on the map (evidence domain).
    """

    id: str
    key: str
    value: str | None
    domain: Domain
    label: str
    field_note: str
    related_tags: tuple[str, ...] = field(default_factory=tuple)
    default_overpass_clause: str | None = None
    default_icon_id: str | None = None

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Glossary
# ---------------------------------------------------------------------------
# Notes on tag selection:
# - We prefer tags that are actually documented and used at scale on OSM.
#   ``cemetery=mass_grave`` is a real (if rare) sub-tag; ``historic=memorial``
#   with ``memorial=mass_grave`` is the more common pattern for documented
#   sites.
# - For "secret detention" / informal sites OSM has no canonical tag — the
#   field note steers investigators to cross-reference, not to invent a tag.
# - ``damage=destroyed`` is the widely accepted Crisis Mapping convention
#   (used by HOTOSM activations); ``building:condition`` is the data-model
#   analogue. We list both because activation tasks differ.
# - The ``evidence`` domain entries don't render on the map — they're the
#   editorial scaffolding (note, source_url, confidence, fixme) the tool
#   stores under the ``hr:`` namespace on placemarks.

_GLOSSARY: tuple[GlossaryEntry, ...] = (
    # ------------------------------------------------------------------
    # Detention
    # ------------------------------------------------------------------
    GlossaryEntry(
        id="amenity-prison",
        key="amenity",
        value="prison",
        domain="detention",
        label="Prison",
        field_note=(
            "The cleanest indicator of formal detention. In conflict zones "
            "cross-reference with landuse=military polygons containing the "
            "prison, as repurposed military barracks may not yet be retagged. "
            "Secret or unofficial detention sites are usually unmapped — survey "
            "Browse mode for unusual building=warehouse near landuse=military."
        ),
        related_tags=(
            "building=prison",
            "landuse=military",
            "building=warehouse",
        ),
        default_overpass_clause='nwr["amenity"="prison"]({{bbox}});',
        default_icon_id="detention-facility",
    ),
    GlossaryEntry(
        id="building-prison",
        key="building",
        value="prison",
        domain="detention",
        label="Prison building",
        field_note=(
            "The building-level analogue of amenity=prison. Use when the "
            "amenity tag is missing but the structure footprint is mapped. "
            "Often co-tagged amenity=prison; the inverse (building only, no "
            "amenity) usually means an incomplete mapping or a former prison."
        ),
        related_tags=("amenity=prison",),
        default_overpass_clause='wr["building"="prison"]({{bbox}});',
        default_icon_id="detention-facility",
    ),
    GlossaryEntry(
        id="building-detention",
        key="building",
        value="detention",
        domain="detention",
        label="Detention building",
        field_note=(
            "Less standardised than building=prison; appears in HOTOSM-led "
            "activations for sites that don't fit a formal prison label "
            "(e.g. police lockups, immigration holding). Always read the "
            "name and note tags before drawing conclusions."
        ),
        related_tags=("amenity=prison", "amenity=police"),
        default_overpass_clause='wr["building"="detention"]({{bbox}});',
        default_icon_id="detention-facility",
    ),
    GlossaryEntry(
        id="amenity-police",
        key="amenity",
        value="police",
        domain="detention",
        label="Police station",
        field_note=(
            "Not strictly detention, but in many jurisdictions police stations "
            "hold detainees in cells without formal prison tagging. Cross-"
            "reference with reports of incommunicado detention before treating "
            "as a detention site on the map."
        ),
        related_tags=("amenity=prison", "building=detention"),
        default_overpass_clause='nwr["amenity"="police"]({{bbox}});',
        default_icon_id="detention-facility",
    ),
    GlossaryEntry(
        id="building-warehouse",
        key="building",
        value="warehouse",
        domain="detention",
        label="Warehouse (cross-reference)",
        field_note=(
            "Plain warehouses are not detention sites — but informal / black-"
            "site detention has historically been operated out of warehouse "
            "structures inside or adjacent to landuse=military areas. Use this "
            "tag in Browse mode for spatial cross-referencing, not as a primary "
            "detention indicator."
        ),
        related_tags=("landuse=military", "amenity=prison"),
        default_overpass_clause='wr["building"="warehouse"]({{bbox}});',
        default_icon_id=None,
    ),

    # ------------------------------------------------------------------
    # Mortality
    # ------------------------------------------------------------------
    GlossaryEntry(
        id="amenity-grave-yard",
        key="amenity",
        value="grave_yard",
        domain="mortality",
        label="Graveyard (small)",
        field_note=(
            "OSM convention reserves amenity=grave_yard for small burial "
            "grounds attached to a place of worship; standalone cemeteries "
            "are tagged landuse=cemetery. Both can be relevant — investigators "
            "should query the union, not either alone."
        ),
        related_tags=("landuse=cemetery", "amenity=place_of_worship"),
        default_overpass_clause='nwr["amenity"="grave_yard"]({{bbox}});',
        default_icon_id="body-recovery",
    ),
    GlossaryEntry(
        id="landuse-cemetery",
        key="landuse",
        value="cemetery",
        domain="mortality",
        label="Cemetery",
        field_note=(
            "Standalone cemeteries. New polygons appearing between satellite "
            "passes in conflict-affected areas warrant attention; OSM tagging "
            "lags reality by months. Compare cemetery extent across imagery "
            "dates rather than trusting the OSM timestamp alone."
        ),
        related_tags=("amenity=grave_yard", "cemetery=mass_grave"),
        default_overpass_clause='wr["landuse"="cemetery"]({{bbox}});',
        default_icon_id="body-recovery",
    ),
    GlossaryEntry(
        id="cemetery-mass-grave",
        key="cemetery",
        value="mass_grave",
        domain="mortality",
        label="Mass grave (sub-tag)",
        field_note=(
            "A documented sub-tag of landuse=cemetery for sites identified "
            "as mass graves. Rare on OSM — most mass graves enter the map "
            "first as historic=memorial with memorial=mass_grave once "
            "memorialisation begins. Treat the absence of this tag as the "
            "norm, not as exonerating evidence."
        ),
        related_tags=("landuse=cemetery", "historic=memorial"),
        default_overpass_clause='wr["cemetery"="mass_grave"]({{bbox}});',
        default_icon_id="mass-grave",
    ),
    GlossaryEntry(
        id="historic-memorial-mass-grave",
        key="memorial",
        value="mass_grave",
        domain="mortality",
        label="Memorial: mass grave",
        field_note=(
            "Combined with historic=memorial. This is the dominant OSM idiom "
            "for documented mass-grave sites with a memorial marker; pre-"
            "memorialisation sites are usually unmapped or hidden under "
            "generic landuse=cemetery. Always pair the query with "
            "historic=memorial in Overpass."
        ),
        related_tags=("historic=memorial", "cemetery=mass_grave"),
        default_overpass_clause='nwr["memorial"="mass_grave"]({{bbox}});',
        default_icon_id="mass-grave",
    ),
    GlossaryEntry(
        id="historic-memorial",
        key="historic",
        value="memorial",
        domain="mortality",
        label="Memorial",
        field_note=(
            "Broad category covering plaques, monuments, and memorial sites. "
            "Refine with the memorial=* sub-tag (war_memorial, mass_grave, "
            "stolperstein, …) when planning a query — the bare historic=memorial "
            "is too noisy in most regions."
        ),
        related_tags=("memorial=war_memorial", "memorial=mass_grave"),
        default_overpass_clause='nwr["historic"="memorial"]({{bbox}});',
        default_icon_id="body-recovery",
    ),
    GlossaryEntry(
        id="memorial-war-memorial",
        key="memorial",
        value="war_memorial",
        domain="mortality",
        label="War memorial",
        field_note=(
            "Combined with historic=memorial. Useful for historical context "
            "around long-running conflicts, but rarely the right tag for "
            "documenting ongoing atrocities — investigators conflating war "
            "memorials with mass-grave sites is a recurring tagging error."
        ),
        related_tags=("historic=memorial", "memorial=mass_grave"),
        default_overpass_clause='nwr["memorial"="war_memorial"]({{bbox}});',
        default_icon_id="body-recovery",
    ),

    # ------------------------------------------------------------------
    # Destruction
    # ------------------------------------------------------------------
    GlossaryEntry(
        id="damage-destroyed",
        key="damage",
        value="destroyed",
        domain="destruction",
        label="Damaged: destroyed",
        field_note=(
            "The Crisis Mapping convention used by HOTOSM activations. Pair "
            "with the relevant building=* on the same element, not as a "
            "standalone tag. Watch for stale damage tags from earlier "
            "activations — confirm with imagery before treating as current."
        ),
        related_tags=("building:condition=damaged", "building=*"),
        default_overpass_clause='wr["damage"="destroyed"]({{bbox}});',
        default_icon_id="shelled-site",
    ),
    GlossaryEntry(
        id="damage-damaged",
        key="damage",
        value="damaged",
        domain="destruction",
        label="Damaged: damaged",
        field_note=(
            "Partial damage, again per the HOTOSM convention. Less reliable "
            "than damage=destroyed because the threshold is mapper-dependent; "
            "always read the note tag and check imagery before drawing "
            "conclusions about severity."
        ),
        related_tags=("damage=destroyed", "building:condition=damaged"),
        default_overpass_clause='wr["damage"="damaged"]({{bbox}});',
        default_icon_id="shelled-site",
    ),
    GlossaryEntry(
        id="building-condition-damaged",
        key="building:condition",
        value="damaged",
        domain="destruction",
        label="Building condition: damaged",
        field_note=(
            "The data-model analogue of damage=damaged — both exist in the "
            "wild and neither is canonical. Query the union when investigating "
            "destruction; rely on building:condition only when you know the "
            "activation followed the more recent tagging guidelines."
        ),
        related_tags=("damage=damaged", "building:condition=destroyed"),
        default_overpass_clause='wr["building:condition"="damaged"]({{bbox}});',
        default_icon_id="shelled-site",
    ),
    GlossaryEntry(
        id="building-condition-destroyed",
        key="building:condition",
        value="destroyed",
        domain="destruction",
        label="Building condition: destroyed",
        field_note=(
            "Same caveat as building:condition=damaged — co-exists with "
            "damage=destroyed and neither is canonical. The two together cover "
            "the bulk of HOTOSM activation tagging; query both."
        ),
        related_tags=("damage=destroyed",),
        default_overpass_clause='wr["building:condition"="destroyed"]({{bbox}});',
        default_icon_id="shelled-site",
    ),
    GlossaryEntry(
        id="abandoned-building",
        key="abandoned:building",
        value=None,
        domain="destruction",
        label="Abandoned building (any)",
        field_note=(
            "Lifecycle prefix tagging — abandoned:building=yes (or the former "
            "value) signals a structure no longer in use. In post-conflict "
            "areas this often precedes a destruction retag; in active conflict "
            "it's frequently mistagged as 'abandoned' when the actual cause is "
            "shelling or forced displacement."
        ),
        related_tags=("damage=destroyed", "ruins=yes"),
        default_overpass_clause='wr["abandoned:building"]({{bbox}});',
        default_icon_id="shelled-site",
    ),
    GlossaryEntry(
        id="ruins-yes",
        key="ruins",
        value="yes",
        domain="destruction",
        label="Ruins",
        field_note=(
            "Historical ruins vs. recent destruction is a common mis-tag. "
            "Pair with the building=* tag and check imagery dates: a ruins=yes "
            "polygon added during an active activation is almost certainly "
            "fresh destruction, not archaeology."
        ),
        related_tags=("damage=destroyed", "historic=ruins"),
        default_overpass_clause='wr["ruins"="yes"]({{bbox}});',
        default_icon_id="shelled-site",
    ),

    # ------------------------------------------------------------------
    # Military
    # ------------------------------------------------------------------
    GlossaryEntry(
        id="landuse-military",
        key="landuse",
        value="military",
        domain="military",
        label="Military area",
        field_note=(
            "Indicates a formally designated military area. Excludes informal "
            "positions and checkpoints — for those see military=checkpoint and "
            "barrier=checkpoint. In active conflict zones the polygon often "
            "lags reality by months; treat as a base layer for cross-referencing, "
            "not as authoritative current extent."
        ),
        related_tags=("military=base", "military=checkpoint", "barrier=military"),
        default_overpass_clause='wr["landuse"="military"]({{bbox}});',
        default_icon_id="military-base",
    ),
    GlossaryEntry(
        id="military-base",
        key="military",
        value="base",
        domain="military",
        label="Military base",
        field_note=(
            "Point or polygon tag for a named military base. Usually co-tagged "
            "with landuse=military on the enclosing polygon; the bare military=base "
            "node is the human-readable label, the landuse polygon is the spatial "
            "footprint."
        ),
        related_tags=("landuse=military", "military=barracks"),
        default_overpass_clause='nwr["military"="base"]({{bbox}});',
        default_icon_id="military-base",
    ),
    GlossaryEntry(
        id="military-barracks",
        key="military",
        value="barracks",
        domain="military",
        label="Barracks",
        field_note=(
            "Sleeping/living quarters on a military installation. Particularly "
            "relevant for detention investigations: repurposed barracks have "
            "historically been used as detention sites without retagging. "
            "Cross-reference with amenity=prison and building=detention."
        ),
        related_tags=("landuse=military", "amenity=prison"),
        default_overpass_clause='nwr["military"="barracks"]({{bbox}});',
        default_icon_id="military-base",
    ),
    GlossaryEntry(
        id="military-checkpoint",
        key="military",
        value="checkpoint",
        domain="military",
        label="Military checkpoint",
        field_note=(
            "Formal military checkpoints. In practice OSM mappers split between "
            "military=checkpoint and barrier=checkpoint — query both. Informal / "
            "ad-hoc checkpoints rarely make it onto the map and are usually only "
            "discoverable via witness reports."
        ),
        related_tags=("barrier=checkpoint", "highway=checkpoint"),
        default_overpass_clause='nwr["military"="checkpoint"]({{bbox}});',
        default_icon_id="checkpoint",
    ),
    GlossaryEntry(
        id="barrier-checkpoint",
        key="barrier",
        value="checkpoint",
        domain="military",
        label="Checkpoint (barrier)",
        field_note=(
            "The barrier-side counterpart to military=checkpoint. More common "
            "in civilian-mapped data and for non-military checkpoints (police, "
            "border). Use the union when surveying checkpoint coverage."
        ),
        related_tags=("military=checkpoint", "barrier=border_control"),
        default_overpass_clause='nwr["barrier"="checkpoint"]({{bbox}});',
        default_icon_id="checkpoint",
    ),
    GlossaryEntry(
        id="barrier-border-control",
        key="barrier",
        value="border_control",
        domain="military",
        label="Border control",
        field_note=(
            "Fixed border crossings. Useful for tracking displacement flows "
            "and forced returns; less useful for documenting violence directly. "
            "Often co-tagged with amenity=customs or border-related infrastructure."
        ),
        related_tags=("barrier=checkpoint", "amenity=customs"),
        default_overpass_clause='nwr["barrier"="border_control"]({{bbox}});',
        default_icon_id="border-crossing",
    ),
    GlossaryEntry(
        id="military-bunker",
        key="military",
        value="bunker",
        domain="military",
        label="Bunker",
        field_note=(
            "Hardened defensive structure. Mostly historical on OSM; new bunker "
            "tagging during a conflict often signals OSINT-driven mapping from "
            "satellite imagery. Read the source tag if present."
        ),
        related_tags=("landuse=military", "historic=bunker"),
        default_overpass_clause='nwr["military"="bunker"]({{bbox}});',
        default_icon_id="military-base",
    ),
    GlossaryEntry(
        id="military-trench",
        key="military",
        value="trench",
        domain="military",
        label="Trench",
        field_note=(
            "Linear defensive earthwork. Rare pre-2022; common in OSINT mapping "
            "of Ukraine-Russia and similar protracted ground conflicts. Cross-"
            "reference with imagery dates before treating as current."
        ),
        related_tags=("military=bunker", "landuse=military"),
        default_overpass_clause='wr["military"="trench"]({{bbox}});',
        default_icon_id="military-base",
    ),

    # ------------------------------------------------------------------
    # Displacement
    # ------------------------------------------------------------------
    GlossaryEntry(
        id="amenity-refugee-site",
        key="amenity",
        value="refugee_site",
        domain="displacement",
        label="Refugee site",
        field_note=(
            "Current canonical tag for refugee/IDP camps (replaces the older "
            "amenity=refugee_housing). Coverage is uneven — UNHCR-operated "
            "sites are well-mapped, informal settlements much less so. Cross-"
            "reference with landuse=residential polygons that lack building "
            "footprints."
        ),
        related_tags=("social_facility=refugee", "landuse=residential"),
        default_overpass_clause='nwr["amenity"="refugee_site"]({{bbox}});',
        default_icon_id="idp-camp",
    ),
    GlossaryEntry(
        id="social-facility-refugee",
        key="social_facility",
        value="refugee",
        domain="displacement",
        label="Social facility: refugee",
        field_note=(
            "Used for buildings providing services to refugees / IDPs — "
            "registration centres, distribution points, shelter offices. "
            "Often co-located with but not the same polygon as the camp itself."
        ),
        related_tags=("amenity=refugee_site", "amenity=social_facility"),
        default_overpass_clause='nwr["social_facility"="refugee"]({{bbox}});',
        default_icon_id="idp-camp",
    ),
    GlossaryEntry(
        id="amenity-shelter",
        key="amenity",
        value="shelter",
        domain="displacement",
        label="Shelter",
        field_note=(
            "A noisy tag — covers hiking shelters, bus shelters, and emergency "
            "shelters indiscriminately. Refine with shelter_type=* "
            "(shelter_type=emergency_shelter is the relevant sub-tag). Avoid "
            "querying amenity=shelter alone in a humanitarian context."
        ),
        related_tags=("shelter_type=emergency_shelter", "amenity=refugee_site"),
        default_overpass_clause='nwr["amenity"="shelter"]["shelter_type"="emergency_shelter"]({{bbox}});',
        default_icon_id="idp-camp",
    ),
    GlossaryEntry(
        id="emergency-assembly-point",
        key="emergency",
        value="assembly_point",
        domain="displacement",
        label="Emergency assembly point",
        field_note=(
            "Designated assembly points (evacuation gathering, disaster muster). "
            "Useful for civil-defence mapping but limited for atrocity work; "
            "include when documenting evacuations or planned displacement."
        ),
        related_tags=("amenity=shelter", "emergency=*"),
        default_overpass_clause='nwr["emergency"="assembly_point"]({{bbox}});',
        default_icon_id="idp-camp",
    ),

    # ------------------------------------------------------------------
    # Civilian (protected infrastructure)
    # ------------------------------------------------------------------
    GlossaryEntry(
        id="amenity-school",
        key="amenity",
        value="school",
        domain="civilian",
        label="School",
        field_note=(
            "Protected under IHL. Attacks on schools are war crimes; cross-"
            "reference with damage=destroyed / damage=damaged within a school "
            "polygon to surface candidate incidents. Note that amenity=school "
            "captures the institution — the building footprint is building=school "
            "and may not be co-tagged."
        ),
        related_tags=("building=school", "amenity=kindergarten", "amenity=university"),
        default_overpass_clause='nwr["amenity"="school"]({{bbox}});',
        default_icon_id="school",
    ),
    GlossaryEntry(
        id="amenity-kindergarten",
        key="amenity",
        value="kindergarten",
        domain="civilian",
        label="Kindergarten",
        field_note=(
            "Separate from amenity=school in OSM. Specifically protected under "
            "IHL and warrants the same destruction cross-referencing. Often "
            "under-mapped relative to schools — absence is not evidence of "
            "absence."
        ),
        related_tags=("amenity=school",),
        default_overpass_clause='nwr["amenity"="kindergarten"]({{bbox}});',
        default_icon_id="school",
    ),
    GlossaryEntry(
        id="amenity-hospital",
        key="amenity",
        value="hospital",
        domain="civilian",
        label="Hospital",
        field_note=(
            "Protected under IHL (Geneva Convention I, Art. 19). Cross-reference "
            "with damage tags to surface attacks on medical facilities. The "
            "healthcare=hospital tag is the newer parallel — query both for "
            "coverage."
        ),
        related_tags=("healthcare=hospital", "amenity=clinic", "amenity=doctors"),
        default_overpass_clause='nwr["amenity"="hospital"]({{bbox}});',
        default_icon_id="hospital",
    ),
    GlossaryEntry(
        id="healthcare-hospital",
        key="healthcare",
        value="hospital",
        domain="civilian",
        label="Healthcare: hospital",
        field_note=(
            "The healthcare=* schema (post-2014) is more precise than amenity=*, "
            "but adoption is uneven by region. Query both amenity=hospital and "
            "healthcare=hospital when mapping; treat the union as canonical."
        ),
        related_tags=("amenity=hospital", "healthcare=*"),
        default_overpass_clause='nwr["healthcare"="hospital"]({{bbox}});',
        default_icon_id="hospital",
    ),
    GlossaryEntry(
        id="amenity-clinic",
        key="amenity",
        value="clinic",
        domain="civilian",
        label="Clinic",
        field_note=(
            "Smaller medical facilities. Equally protected under IHL but often "
            "more critical to ground-level humanitarian operations than full "
            "hospitals. Coverage is often better than hospital in rural and "
            "displaced-persons settings."
        ),
        related_tags=("healthcare=clinic", "amenity=hospital", "amenity=doctors"),
        default_overpass_clause='nwr["amenity"="clinic"]({{bbox}});',
        default_icon_id="hospital",
    ),
    GlossaryEntry(
        id="amenity-doctors",
        key="amenity",
        value="doctors",
        domain="civilian",
        label="Doctors / surgery",
        field_note=(
            "Private practice / outpatient. Common in urban OSM data, sparse in "
            "rural; treat as a supporting indicator alongside clinic / hospital "
            "queries rather than a primary medical-coverage tag."
        ),
        related_tags=("amenity=clinic", "healthcare=doctor"),
        default_overpass_clause='nwr["amenity"="doctors"]({{bbox}});',
        default_icon_id="hospital",
    ),
    GlossaryEntry(
        id="amenity-place-of-worship",
        key="amenity",
        value="place_of_worship",
        domain="civilian",
        label="Place of worship",
        field_note=(
            "Protected under IHL (Hague Convention 1954 for cultural property). "
            "Refine with religion=* and denomination=* to surface targeted "
            "attacks on specific communities. A mosque/church/temple destroyed "
            "during conflict is candidate evidence — pair with damage tags."
        ),
        related_tags=("religion=*", "building=mosque", "building=church"),
        default_overpass_clause='nwr["amenity"="place_of_worship"]({{bbox}});',
        default_icon_id="religious-site",
    ),
    GlossaryEntry(
        id="amenity-marketplace",
        key="amenity",
        value="marketplace",
        domain="civilian",
        label="Marketplace",
        field_note=(
            "Civilian gathering site, recurringly targeted. Indiscriminate "
            "attacks on marketplaces are war crimes; geographic clustering of "
            "damage tags near amenity=marketplace nodes is a strong candidate "
            "incident pattern."
        ),
        related_tags=("amenity=shop", "shop=*"),
        default_overpass_clause='nwr["amenity"="marketplace"]({{bbox}});',
        default_icon_id=None,
    ),
    GlossaryEntry(
        id="man-made-water-well",
        key="man_made",
        value="water_well",
        domain="civilian",
        label="Water well",
        field_note=(
            "Objects indispensable to civilian survival (AP I, Art. 54) include "
            "drinking-water installations. Destruction or contamination of wells "
            "is specifically prohibited. Coverage is uneven — humanitarian "
            "operations sometimes map wells in waves, so date the tags."
        ),
        related_tags=("man_made=water_tower", "amenity=drinking_water"),
        default_overpass_clause='nwr["man_made"="water_well"]({{bbox}});',
        default_icon_id="water-source",
    ),
    GlossaryEntry(
        id="man-made-water-tower",
        key="man_made",
        value="water_tower",
        domain="civilian",
        label="Water tower",
        field_note=(
            "Visible municipal-water infrastructure. Targeting water towers in "
            "conflict is among the most documented attacks on civilian "
            "survival infrastructure; cross-reference with damage tags."
        ),
        related_tags=("man_made=water_well", "man_made=reservoir_covered"),
        default_overpass_clause='nwr["man_made"="water_tower"]({{bbox}});',
        default_icon_id="water-source",
    ),
    GlossaryEntry(
        id="amenity-drinking-water",
        key="amenity",
        value="drinking_water",
        domain="civilian",
        label="Drinking water",
        field_note=(
            "Public drinking-water points. Often dense in IDP camps and refugee "
            "sites — the spatial distribution is itself a humanitarian "
            "indicator. Treat sparse coverage in a displaced population as a "
            "data-gap rather than confirmed absence."
        ),
        related_tags=("man_made=water_well", "amenity=refugee_site"),
        default_overpass_clause='nwr["amenity"="drinking_water"]({{bbox}});',
        default_icon_id="water-source",
    ),
    GlossaryEntry(
        id="amenity-university",
        key="amenity",
        value="university",
        domain="civilian",
        label="University",
        field_note=(
            "Higher-education sites. Protected under IHL on the same grounds as "
            "schools; in many conflicts, universities have been targeted "
            "specifically for their role in civil society. Cross-reference with "
            "damage tags."
        ),
        related_tags=("amenity=school", "amenity=college"),
        default_overpass_clause='nwr["amenity"="university"]({{bbox}});',
        default_icon_id="school",
    ),
    GlossaryEntry(
        id="amenity-library",
        key="amenity",
        value="library",
        domain="civilian",
        label="Library",
        field_note=(
            "Cultural property under the Hague Convention 1954. Library "
            "destruction in conflict often signals deliberate cultural erasure; "
            "treat alongside place_of_worship and historic=monument when "
            "investigating cultural-heritage targeting."
        ),
        related_tags=("amenity=place_of_worship", "historic=monument"),
        default_overpass_clause='nwr["amenity"="library"]({{bbox}});',
        default_icon_id="religious-site",
    ),
    GlossaryEntry(
        id="historic-monument",
        key="historic",
        value="monument",
        domain="civilian",
        label="Historic monument",
        field_note=(
            "Cultural property under the Hague Convention 1954. Distinct from "
            "historic=memorial: monuments are pre-existing cultural objects, "
            "memorials commemorate events. Both are protected; query both when "
            "documenting cultural-heritage destruction."
        ),
        related_tags=("historic=memorial", "amenity=place_of_worship"),
        default_overpass_clause='nwr["historic"="monument"]({{bbox}});',
        default_icon_id="religious-site",
    ),
    GlossaryEntry(
        id="historic-archaeological-site",
        key="historic",
        value="archaeological_site",
        domain="civilian",
        label="Archaeological site",
        field_note=(
            "Sites with documented archaeological value. Looting during "
            "conflict (cf. Iraq 2003, Syria 2011–) is itself a war crime under "
            "the 1954 Hague Convention and 1999 Second Protocol. Pair with "
            "imagery analysis for looting-pit signatures, not just OSM tags."
        ),
        related_tags=("historic=monument", "historic=ruins"),
        default_overpass_clause='nwr["historic"="archaeological_site"]({{bbox}});',
        default_icon_id="religious-site",
    ),
    GlossaryEntry(
        id="aeroway-aerodrome",
        key="aeroway",
        value="aerodrome",
        domain="civilian",
        label="Aerodrome / airport",
        field_note=(
            "Dual-use infrastructure — civilian airports become legitimate "
            "military targets under IHL once used by armed forces, but the "
            "civilian status at the time of attack is the relevant question. "
            "Read aerodrome=civil / aerodrome=military and military=airfield "
            "before drawing conclusions."
        ),
        related_tags=("aeroway=runway", "military=airfield"),
        default_overpass_clause='nwr["aeroway"="aerodrome"]({{bbox}});',
        default_icon_id=None,
    ),
    GlossaryEntry(
        id="power-plant",
        key="power",
        value="plant",
        domain="civilian",
        label="Power plant",
        field_note=(
            "Energy infrastructure. AP I Art. 56 specifically protects "
            "installations containing dangerous forces (dams, dykes, nuclear "
            "stations) — pair with plant:source=nuclear / power=generator + "
            "generator:source=* before classifying. Strikes on non-nuclear power "
            "are still relevant for documenting civilian-infrastructure attacks."
        ),
        related_tags=("plant:source=*", "power=generator", "power=substation"),
        default_overpass_clause='wr["power"="plant"]({{bbox}});',
        default_icon_id=None,
    ),

    # ------------------------------------------------------------------
    # Evidence (editorial / OSM workflow — not normally rendered)
    # ------------------------------------------------------------------
    GlossaryEntry(
        id="source",
        key="source",
        value=None,
        domain="evidence",
        label="Source",
        field_note=(
            "Standard OSM tag documenting how a feature was mapped (survey, "
            "Bing imagery, Maxar, …). For atrocity investigation, the source "
            "tag is your first stop in assessing whether a feature reflects "
            "ground-truth or remote tracing — and how stale the underlying "
            "evidence is."
        ),
        related_tags=("source:date=*", "source:tracker=*"),
        default_overpass_clause=None,
        default_icon_id=None,
    ),
    GlossaryEntry(
        id="source-date",
        key="source:date",
        value=None,
        domain="evidence",
        label="Source date",
        field_note=(
            "Free-text date of the source used to map a feature (e.g. the "
            "satellite imagery capture date). Always check source:date when "
            "the source is remote imagery; a months-old image in a fast-moving "
            "conflict is a stale tracing."
        ),
        related_tags=("source=*",),
        default_overpass_clause=None,
        default_icon_id=None,
    ),
    GlossaryEntry(
        id="fixme",
        key="fixme",
        value=None,
        domain="evidence",
        label="FIXME (mapper note)",
        field_note=(
            "Free-text note from the original mapper flagging uncertainty. "
            "In conflict-zone tagging FIXMEs often encode the most useful "
            "investigator-facing context (e.g. 'building destroyed Mar 2022, "
            "tagging unclear'). Always read FIXME before trusting a feature."
        ),
        related_tags=("note=*",),
        default_overpass_clause=None,
        default_icon_id=None,
    ),
    GlossaryEntry(
        id="note",
        key="note",
        value=None,
        domain="evidence",
        label="Note (mapper)",
        field_note=(
            "Free-text editorial note. Distinct from the hr:note annotation "
            "this tool stores — the OSM note=* tag is public and authored by "
            "the original mapper, while hr:note is investigator-private. Read "
            "OSM note before adding hr:note."
        ),
        related_tags=("fixme=*", "description=*"),
        default_overpass_clause=None,
        default_icon_id=None,
    ),
    GlossaryEntry(
        id="description",
        key="description",
        value=None,
        domain="evidence",
        label="Description",
        field_note=(
            "Longer-form free text. Less common than note=* but often used in "
            "humanitarian activations to encode incident-level detail (e.g. "
            "attack date, casualty count). Search description=* in Browse mode "
            "when looking for narrative evidence within tags."
        ),
        related_tags=("note=*", "fixme=*"),
        default_overpass_clause=None,
        default_icon_id=None,
    ),
    GlossaryEntry(
        id="start-date",
        key="start_date",
        value=None,
        domain="evidence",
        label="Start date",
        field_note=(
            "ISO 8601 (or partial-date) when a feature came into existence. "
            "For destruction documentation, a start_date on a damage tag is "
            "the closest OSM gets to a timeline; treat as investigator-provided "
            "not authoritative."
        ),
        related_tags=("end_date=*", "source:date=*"),
        default_overpass_clause=None,
        default_icon_id=None,
    ),
    GlossaryEntry(
        id="end-date",
        key="end_date",
        value=None,
        domain="evidence",
        label="End date",
        field_note=(
            "ISO 8601 (or partial) when a feature ceased to exist — typical "
            "for destroyed buildings tagged after the fact. Combine with "
            "lifecycle prefixes (destroyed:building=*, demolished:building=*) "
            "when the mapper hasn't deleted the feature."
        ),
        related_tags=("start_date=*", "abandoned:building=*", "demolished:building=*"),
        default_overpass_clause=None,
        default_icon_id=None,
    ),
)


_BY_ID: dict[str, GlossaryEntry] = {e.id: e for e in _GLOSSARY}


def all_entries() -> list[GlossaryEntry]:
    """Return the full glossary in declaration order."""
    return list(_GLOSSARY)


def find(key: str, value: str | None = None) -> list[GlossaryEntry]:
    """Return glossary entries matching ``key`` (and optionally ``value``).

    Matching rules:

    * ``find("amenity")`` returns every entry where ``key == "amenity"``,
      regardless of ``value``.
    * ``find("amenity", "prison")`` returns entries where both match.
    * ``find("amenity", None)`` on a wildcard entry (e.g. ``key=*``) returns
      that entry — value=None glossary entries match any value query, but
      explicit value queries only match entries with the same value.
    """
    out: list[GlossaryEntry] = []
    for entry in _GLOSSARY:
        if entry.key != key:
            continue
        if value is None:
            out.append(entry)
            continue
        # Caller supplied a concrete value: match exact or the wildcard entry.
        if entry.value == value or entry.value is None:
            out.append(entry)
    return out


def by_id(entry_id: str) -> GlossaryEntry | None:
    """Look up an entry by stable id, or ``None`` if unknown."""
    return _BY_ID.get(entry_id)
