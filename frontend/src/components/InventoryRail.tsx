/**
 * InventoryRail — the right rail for Browse mode (Field Atlas).
 *
 * Three states:
 *  1. Domain cards view (default after inventory loads) — an 8-card grid of
 *     OSM domains, each card showing count + chip-rail of top tag pairs.
 *  2. Drill-in view — a flat list of features for one domain (typically
 *     filtered to a single key=value scope by clicking a domain card).
 *  3. Feature detail view — owned by FeatureDetail.tsx; rendered when the
 *     parent BrowseMode hands us a selectedFeatureId.
 *
 * Search box at the top filters across the active list (cards or items).
 *
 * Header always shows the area summary card: bbox size in km², total
 * feature count, and "fetched X minutes ago" timestamp.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import type {
  BrowseBbox,
  BrowseInventoryResponse,
  BrowseItemSummary,
} from "@/lib/types";

// Domain → small SVG glyph. Reconnaissance is neutral, so we use simple
// geometric shapes instead of pictograms — circle/square/diamond/etc.
// Drawing them inline keeps the bundle small and dodges a webfont round-trip.
const DOMAIN_GLYPHS: Record<string, ReactNode> = {
  Amenities: <circle cx="8" cy="8" r="5" />,
  Buildings: <rect x="3" y="3" width="10" height="10" />,
  Landuse: <polygon points="8,2 14,8 8,14 2,8" />,
  Historic: <polygon points="8,2 14,14 2,14" />,
  Military: <polygon points="8,2 14,6 11,14 5,14 2,6" />,
  Highways: <line x1="2" y1="8" x2="14" y2="8" strokeWidth="2.5" />,
  Natural: <path d="M2 10 Q 5 4, 8 10 T 14 10" fill="none" strokeWidth="1.8" />,
  Manmade: <rect x="3" y="6" width="10" height="4" />,
  Other: <circle cx="8" cy="8" r="2.5" />,
};

function DomainGlyph({ name }: { name: string }) {
  const glyph = DOMAIN_GLYPHS[name] ?? DOMAIN_GLYPHS.Other;
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="fill-[var(--color-ink-soft)] stroke-[var(--color-ink-soft)]"
      style={{ flexShrink: 0 }}
    >
      {glyph}
    </svg>
  );
}

interface DrillScope {
  domain: string;
  key: string | null;
  value: string | null;
}

interface Props {
  bbox: BrowseBbox;
  inventory: BrowseInventoryResponse | null;
  inventoryLoading: boolean;
  inventoryError: string | null;
  inventoryFetchedAt: number | null;
  hoveredOsmId: string | null;
  selectedOsmId: string | null;
  onHoverItem: (osmId: string | null) => void;
  onSelectItem: (osmId: string) => void;
  onRefetch: () => void;
}

export function InventoryRail({
  bbox,
  inventory,
  inventoryLoading,
  inventoryError,
  inventoryFetchedAt,
  hoveredOsmId,
  selectedOsmId,
  onHoverItem,
  onSelectItem,
  onRefetch,
}: Props) {
  const [drill, setDrill] = useState<DrillScope | null>(null);
  const [search, setSearch] = useState("");

  // Reset drill state when the bbox changes — different area = different
  // inventory. Without this you'd land in a stale drill-in.
  useEffect(() => {
    setDrill(null);
    setSearch("");
  }, [bbox.join(",")]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface-raised)]">
      <AreaSummaryCard
        bbox={bbox}
        inventory={inventory}
        inventoryLoading={inventoryLoading}
        inventoryError={inventoryError}
        inventoryFetchedAt={inventoryFetchedAt}
        onRefetch={onRefetch}
      />

      {/* Search bar — filters domain cards or drill-in rows. */}
      <div className="shrink-0 border-b border-[var(--color-line)] px-3 py-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder={drill ? "Filter features…" : "Filter domains…"}
          className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {inventoryError ? (
          <div className="p-4 text-sm text-[var(--color-danger)]">
            {inventoryError}
          </div>
        ) : inventoryLoading && !inventory ? (
          <div className="p-4 text-sm italic text-[var(--color-ink-faint)]">
            Querying Overpass — this can take 10–30s for a fresh bbox.
          </div>
        ) : inventory && inventory.area_capped ? (
          <AreaCappedView inventory={inventory} />
        ) : drill && inventory && !inventory.area_capped ? (
          <DrillInView
            bbox={bbox}
            scope={drill}
            search={search}
            hoveredOsmId={hoveredOsmId}
            selectedOsmId={selectedOsmId}
            onBack={() => setDrill(null)}
            onHoverItem={onHoverItem}
            onSelectItem={onSelectItem}
          />
        ) : inventory && !inventory.area_capped && inventory.domains ? (
          <DomainCardsView
            domains={inventory.domains}
            search={search}
            onDrill={(d) => setDrill(d)}
          />
        ) : (
          <div className="p-4 text-sm italic text-[var(--color-ink-faint)]">
            Pick an area to begin reconnaissance.
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Subcomponents
// ────────────────────────────────────────────────────────────────────────────

function AreaSummaryCard({
  bbox,
  inventory,
  inventoryLoading,
  inventoryError,
  inventoryFetchedAt,
  onRefetch,
}: {
  bbox: BrowseBbox;
  inventory: BrowseInventoryResponse | null;
  inventoryLoading: boolean;
  inventoryError: string | null;
  inventoryFetchedAt: number | null;
  onRefetch: () => void;
}) {
  const areaKm2 = inventory?.area_km2 ?? bboxAreaKm2(bbox);
  const totalCount = inventory?.total_count ?? null;
  const fetchedAgo = useTimeAgo(inventoryFetchedAt);

  return (
    <div className="shrink-0 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
        Area summary
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
        <div className="text-xs text-[var(--color-ink-faint)]">Size</div>
        <div className="text-right font-[var(--font-mono)] text-xs text-[var(--color-ink)]">
          {areaKm2.toFixed(1)} km²
        </div>
        <div className="text-xs text-[var(--color-ink-faint)]">Features</div>
        <div className="text-right font-[var(--font-mono)] text-xs text-[var(--color-ink)]">
          {totalCount != null ? totalCount.toLocaleString() : "—"}
        </div>
        <div className="text-xs text-[var(--color-ink-faint)]">Fetched</div>
        <div className="text-right text-xs text-[var(--color-ink-soft)]">
          {fetchedAgo ?? (inventoryLoading ? "…" : "—")}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <div className="truncate font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]" title={bbox.join(", ")}>
          {bbox.map((n) => n.toFixed(3)).join(", ")}
        </div>
        <button
          type="button"
          onClick={onRefetch}
          disabled={inventoryLoading}
          className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {inventoryLoading ? "…" : "Refetch"}
        </button>
      </div>
      {inventoryError && (
        <div className="mt-2 text-[11px] text-[var(--color-danger)]">{inventoryError}</div>
      )}
    </div>
  );
}

function AreaCappedView({ inventory }: { inventory: BrowseInventoryResponse }) {
  return (
    <div className="p-4 text-sm text-[var(--color-ink-soft)]">
      <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
          Area too large
        </div>
        <p className="mt-1 text-xs leading-relaxed">
          This bbox is {inventory.area_km2.toFixed(0)} km² — over the
          {" "}
          {inventory.area_cap_km2.toFixed(0)} km² preview cap. Narrow your
          area to fetch geometry. Counts shown below are reconnaissance only.
        </p>
      </div>
      <div className="mt-3 space-y-1">
        {inventory.domain_counts &&
          Object.entries(inventory.domain_counts)
            .sort(([, a], [, b]) => b - a)
            .map(([name, count]) => (
              <div
                key={name}
                className="flex items-center justify-between rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <DomainGlyph name={name} />
                  <span className="text-xs text-[var(--color-ink)]">{name}</span>
                </div>
                <span className="font-[var(--font-mono)] text-xs text-[var(--color-ink-soft)]">
                  {count.toLocaleString()}
                </span>
              </div>
            ))}
      </div>
    </div>
  );
}

function DomainCardsView({
  domains,
  search,
  onDrill,
}: {
  domains: BrowseInventoryResponse["domains"];
  search: string;
  onDrill: (d: DrillScope) => void;
}) {
  const filtered = useMemo(() => {
    if (!domains) return [];
    const q = search.trim().toLowerCase();
    if (!q) return domains;
    return domains.filter((d) => {
      if (d.name.toLowerCase().includes(q)) return true;
      return d.top_tags.some(
        (t) =>
          t.key.toLowerCase().includes(q) ||
          t.value.toLowerCase().includes(q),
      );
    });
  }, [domains, search]);

  if (!domains || domains.length === 0) {
    return (
      <div className="p-4 text-sm italic text-[var(--color-ink-faint)]">
        No features in this bbox. Try a different area.
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <div className="p-4 text-sm italic text-[var(--color-ink-faint)]">
        No domains match “{search}”.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2 p-3 xl:grid-cols-2">
      {filtered.map((d) => (
        <DomainCard
          key={d.name}
          domain={d}
          onClick={() =>
            onDrill({
              domain: d.name,
              key: d.top_tags[0]?.key ?? null,
              value: d.top_tags[0]?.value ?? null,
            })
          }
          onClickTag={(key, value) =>
            onDrill({ domain: d.name, key, value })
          }
        />
      ))}
    </div>
  );
}

function DomainCard({
  domain,
  onClick,
  onClickTag,
}: {
  domain: NonNullable<BrowseInventoryResponse["domains"]>[number];
  onClick: () => void;
  onClickTag: (key: string, value: string) => void;
}) {
  return (
    <div
      className="group relative overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] p-2.5 transition-colors hover:border-[var(--color-line-strong)]"
      style={{
        backgroundImage:
          "repeating-linear-gradient(90deg, transparent 0 6px, color-mix(in oklab, var(--color-line) 35%, transparent) 6px 7px)",
        backgroundSize: "100% 100%",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right -200px center",
      }}
    >
      {/* Subtle topographic-line motif at the right edge — clipped so it
          only shows as a fine vertical hatching, not loud. */}
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-2 text-left"
      >
        <DomainGlyph name={domain.name} />
        <span className="font-[var(--font-display)] text-sm text-[var(--color-ink)]">
          {domain.name}
        </span>
        <span className="ml-auto font-[var(--font-mono)] text-xs text-[var(--color-ink-soft)]">
          {domain.count.toLocaleString()}
        </span>
      </button>
      {domain.top_tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {domain.top_tags.map((t) => (
            <button
              key={`${t.key}=${t.value}`}
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                onClickTag(t.key, t.value);
              }}
              className="rounded-sm border border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-1.5 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              title={`${t.key}=${t.value} · ${t.count}`}
            >
              {t.value} <span className="text-[var(--color-ink-faint)]">×{t.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DrillInView({
  bbox,
  scope,
  search,
  hoveredOsmId,
  selectedOsmId,
  onBack,
  onHoverItem,
  onSelectItem,
}: {
  bbox: BrowseBbox;
  scope: DrillScope;
  search: string;
  hoveredOsmId: string | null;
  selectedOsmId: string | null;
  onBack: () => void;
  onHoverItem: (osmId: string | null) => void;
  onSelectItem: (osmId: string) => void;
}) {
  const [items, setItems] = useState<BrowseItemSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!scope.key || !scope.value) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    setItems([]);
    setNextOffset(0);
    setHasMore(false);
    (async () => {
      try {
        const result = await api.browse.items(bbox, scope.key!, scope.value!, 0);
        if (cancelled) return;
        setItems(result.items);
        setHasMore(result.has_more);
        setNextOffset(result.next_offset);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bbox.join(","), scope.key, scope.value]);

  async function loadMore() {
    if (!scope.key || !scope.value) return;
    setLoading(true);
    try {
      const result = await api.browse.items(bbox, scope.key, scope.value, nextOffset);
      setItems((prev) => [...prev, ...result.items]);
      setHasMore(result.has_more);
      setNextOffset(result.next_offset);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      if (it.name?.toLowerCase().includes(q)) return true;
      return Object.entries(it.tags).some(
        ([k, v]) =>
          k.toLowerCase().includes(q) || v.toLowerCase().includes(q),
      );
    });
  }, [items, search]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
          aria-label="Back to domain cards"
          title="Back"
        >
          ←
        </button>
        <div className="flex items-center gap-1.5">
          <DomainGlyph name={scope.domain} />
          <span className="text-xs uppercase tracking-wider text-[var(--color-ink-faint)]">
            {scope.domain}
          </span>
        </div>
        {scope.key && scope.value && (
          <code className="ml-1 rounded bg-[var(--color-surface-sunken)] px-1.5 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-soft)]">
            {scope.key}={scope.value}
          </code>
        )}
      </div>
      {/* Non-list message states stay in normal flow so the windowed
          renderer below owns the scrollable region exclusively. */}
      {error && (
        <div className="shrink-0 p-3 text-sm text-[var(--color-danger)]">{error}</div>
      )}
      {!error && loading && items.length === 0 && (
        <div className="shrink-0 p-3 text-sm italic text-[var(--color-ink-faint)]">Loading…</div>
      )}
      {!error && !loading && filtered.length === 0 && items.length > 0 && (
        <div className="shrink-0 p-3 text-sm italic text-[var(--color-ink-faint)]">
          No features match “{search}”.
        </div>
      )}
      {!error && !loading && items.length === 0 && (
        <div className="shrink-0 p-3 text-sm italic text-[var(--color-ink-faint)]">
          No features in this scope.
        </div>
      )}
      {filtered.length > 0 && (
        <VirtualizedItemList
          items={filtered}
          hoveredOsmId={hoveredOsmId}
          selectedOsmId={selectedOsmId}
          onHover={onHoverItem}
          onSelect={onSelectItem}
        />
      )}
      {hasMore && (
        <div className="shrink-0 border-t border-[var(--color-line)] p-2">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] py-1.5 text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] disabled:opacity-60"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// VirtualizedItemList — windowed renderer for the drill-in list.
//
// Each ItemRow is fixed-height (52px including the divider). We render only
// the slice currently inside the viewport plus a 10-row buffer above and
// below to mask scroll-jank, then pad above/below with spacer divs so the
// scrollbar reports the correct total. This keeps the DOM tiny (~30 rows
// max) even when `items.length` is in the tens of thousands.
//
// Two design choices worth noting:
//   * We own the scroll container ourselves instead of measuring an ancestor
//     — that way the drill-in's height is constrained by `flex-1` from the
//     parent, and we don't have to coordinate `overflow` rules across two
//     levels of layout.
//   * We listen to a ResizeObserver instead of a window resize handler so
//     dock-resize / rail-resize updates the visible window without a page
//     reflow event.
// ────────────────────────────────────────────────────────────────────────────

const ROW_HEIGHT_PX = 52;
const ROW_BUFFER = 10;

function VirtualizedItemList({
  items,
  hoveredOsmId,
  selectedOsmId,
  onHover,
  onSelect,
}: {
  items: BrowseItemSummary[];
  hoveredOsmId: string | null;
  selectedOsmId: string | null;
  onHover: (osmId: string | null) => void;
  onSelect: (osmId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Measure the viewport height. We start at 0; the ResizeObserver fires
  // synchronously after layout, so the first paint will render an empty
  // window but the second paint will fill — barely a perceptible flash.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = items.length;
  const totalHeight = total * ROW_HEIGHT_PX;

  // Compute the visible window. With a 0-height viewport we render nothing.
  const rawStart = Math.floor(scrollTop / ROW_HEIGHT_PX);
  const rawEnd = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT_PX);
  const visibleStart = Math.max(0, rawStart - ROW_BUFFER);
  const visibleEnd = Math.min(total, rawEnd + ROW_BUFFER);
  const slice = items.slice(visibleStart, visibleEnd);
  const topSpacer = visibleStart * ROW_HEIGHT_PX;
  const bottomSpacer = Math.max(0, totalHeight - visibleEnd * ROW_HEIGHT_PX);

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-y-auto"
      role="list"
      aria-label="Feature inventory"
    >
      <div style={{ height: topSpacer }} aria-hidden="true" />
      <ul className="divide-y divide-[var(--color-line)]">
        {slice.map((it) => (
          <ItemRow
            key={it.osm_id}
            item={it}
            isHovered={hoveredOsmId === it.osm_id}
            isSelected={selectedOsmId === it.osm_id}
            onHover={onHover}
            onClick={() => onSelect(it.osm_id)}
          />
        ))}
      </ul>
      <div style={{ height: bottomSpacer }} aria-hidden="true" />
    </div>
  );
}

const GEOMETRY_GLYPHS: Record<string, string> = {
  Point: "·",
  LineString: "─",
  Polygon: "▢",
  Relation: "◆",
  Unknown: "?",
};

function ItemRow({
  item,
  isHovered,
  isSelected,
  onHover,
  onClick,
}: {
  item: BrowseItemSummary;
  isHovered: boolean;
  isSelected: boolean;
  onHover: (osmId: string | null) => void;
  onClick: () => void;
}) {
  // Dominant tag pair — first entry that isn't a name/ref/source. Falls back
  // to the first tag if all are administrative.
  const dominantTag = useMemo(() => {
    const skip = new Set(["name", "ref", "source", "fixme", "note", "@id"]);
    for (const [k, v] of Object.entries(item.tags)) {
      if (!skip.has(k) && !k.startsWith("name:") && !k.startsWith("source:")) {
        return { key: k, value: v };
      }
    }
    const first = Object.entries(item.tags)[0];
    return first ? { key: first[0], value: first[1] } : null;
  }, [item.tags]);

  const glyph = GEOMETRY_GLYPHS[item.geometry_kind] ?? GEOMETRY_GLYPHS.Unknown;

  return (
    // Fixed height so VirtualizedItemList's spacer math matches reality.
    // The previous layout grew the row when dominantTag was present — that
    // worked when we rendered every row, but a windowed renderer needs
    // predictable row height to compute scroll offsets.
    <li style={{ height: ROW_HEIGHT_PX }}>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => onHover(item.osm_id)}
        onMouseLeave={() => onHover(null)}
        className={[
          "flex h-full w-full flex-col justify-center px-3 py-1.5 text-left transition-colors",
          isSelected
            ? "bg-[var(--color-accent-soft)]"
            : isHovered
              ? "bg-[var(--color-surface-sunken)]"
              : "hover:bg-[var(--color-surface-sunken)]",
        ].join(" ")}
      >
        <div className="flex items-center gap-2">
          <span
            className="shrink-0 font-[var(--font-mono)] text-[var(--color-ink-faint)]"
            style={{ fontSize: "13px", lineHeight: "1" }}
            aria-hidden="true"
          >
            {glyph}
          </span>
          <span
            className={[
              "min-w-0 flex-1 truncate text-sm",
              item.name
                ? "text-[var(--color-ink)]"
                : "italic text-[var(--color-ink-faint)]",
            ].join(" ")}
          >
            {item.name ?? "〈unnamed〉"}
          </span>
        </div>
        {/* Always render the second line — even empty — so heights agree.
            We zero out the text when there's no dominant tag rather than
            omitting the div, which would change the row height. */}
        <div
          className="mt-0.5 h-[12px] truncate pl-5 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-soft)]"
          aria-hidden={dominantTag ? undefined : true}
        >
          {dominantTag ? `${dominantTag.key}=${dominantTag.value}` : " "}
        </div>
      </button>
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Approximate bbox area in km², matching the backend's equirectangular
 * shortcut so the header readout agrees with the inventory cap decision. */
function bboxAreaKm2(bbox: BrowseBbox): number {
  const [west, south, east, north] = bbox;
  if (east < west || north < south) return 0;
  const meanLatRad = (((south + north) / 2) * Math.PI) / 180;
  const kmPerDegLat = 110.574;
  const kmPerDegLon = 111.320 * Math.cos(meanLatRad);
  const dy = (north - south) * kmPerDegLat;
  const dx = (east - west) * kmPerDegLon;
  return Math.max(0, dx * dy);
}

/** Render a timestamp as "Xs/m/h ago", re-running every 30s while mounted so
 * the header readout stays roughly fresh without burning a per-second tick. */
function useTimeAgo(ts: number | null): string | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (ts == null) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [ts]);
  if (ts == null) return null;
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
