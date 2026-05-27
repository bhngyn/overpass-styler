/**
 * BrowseMode — top-level container for the Field Atlas destination.
 *
 * Layout: map-dominant centre, single right rail (Inventory or FeatureDetail).
 * The thin top command strip carries: place search (Nominatim), "Draw area"
 * stub, "Use current viewport" button, area-size readout, "Refetch" button.
 * Title bar shows a RECON small-caps eyebrow + a "← Back to project"
 * affordance when there's a parked project to return to.
 *
 * Internal state is intentionally component-local (NOT in Zustand):
 *   - bbox: BrowseBbox | null
 *   - inventory: BrowseInventoryResponse | null
 *   - selectedFeatureId: string | null
 *   - bakeOpen: { prefill } | null
 *
 * Browse is exploratory — drop-in/drop-out, not persisted. If we want to
 * resume an investigator's last Browse session we can revisit, but that's
 * a v2 concern. For v1 the state is ephemeral.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { useProjectStore } from "@/stores/project";
import type {
  BrowseBbox,
  BrowseInventoryResponse,
} from "@/lib/types";
import { BrowseMap, type BrowseMapHandle } from "./BrowseMap";
import { InventoryRail } from "./InventoryRail";
import { FeatureDetail, type BakeHandoffPrefill } from "./FeatureDetail";
import { BakeHandoffModal } from "./BakeHandoffModal";

interface NominatimHit {
  display_name: string;
  boundingbox: [string, string, string, string]; // [south, north, west, east] as strings
}

export function BrowseMode() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const currentProject = useProjectStore((s) => s.currentProject);
  const setMode = useProjectStore((s) => s.setMode);
  const refreshProjects = useProjectStore((s) => s.refreshProjects);

  const mapRef = useRef<BrowseMapHandle | null>(null);

  // Browse-local state.
  const [bbox, setBbox] = useState<BrowseBbox | null>(null);
  const [inventory, setInventory] = useState<BrowseInventoryResponse | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventoryFetchedAt, setInventoryFetchedAt] = useState<number | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [hoveredFeatureId, setHoveredFeatureId] = useState<string | null>(null);
  const [bakeOpen, setBakeOpen] = useState<{ prefill: BakeHandoffPrefill } | null>(null);

  // Make sure the project list is fresh — BakeHandoffModal renders its
  // destination dropdown from it, and an investigator landing in Browse
  // for the first time might have never triggered refreshProjects.
  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  // Fetch inventory whenever bbox changes. Clears selection so the rail
  // returns to the domain-cards view for the new area.
  async function fetchInventory(forBbox: BrowseBbox) {
    setInventoryLoading(true);
    setInventoryError(null);
    setSelectedFeatureId(null);
    try {
      const result = await api.browse.inventory(forBbox);
      setInventory(result);
      setInventoryFetchedAt(Date.now());
    } catch (e) {
      setInventoryError(String(e));
      setInventory(null);
    } finally {
      setInventoryLoading(false);
    }
  }

  useEffect(() => {
    if (bbox) {
      void fetchInventory(bbox);
    } else {
      setInventory(null);
      setInventoryFetchedAt(null);
    }
    // We use a string key for stable comparison — array reference would
    // refetch every render since setBbox creates a fresh tuple each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bbox?.join(",")]);

  // Items rendered on the map. We don't pre-fetch every drill-in scope;
  // instead we feed BrowseMap the dots from inventory.summary.bbox when we
  // have a non-capped inventory and the user hasn't drilled in. For v1
  // this is simplification — the dots reflect "what's been fetched" rather
  // than "everything in the bbox". A future pass can flatten per-domain
  // top items into the muted-ink layer on inventory load.
  const mapItems = useMemo(() => {
    // For now we don't have per-feature centers in the summary payload
    // (only domain counts + top tags). Future work could either return
    // centers from /inventory or pre-fetch the top-N per domain. v1
    // keeps the map clean — the bbox mask is the primary spatial cue.
    return [];
  }, [inventory]);

  function captureViewport() {
    const map = mapRef.current;
    if (!map) return;
    const next = map.getViewportBbox();
    if (next) setBbox(next);
  }

  function onSearchPick(hit: NominatimHit) {
    const south = parseFloat(hit.boundingbox[0]);
    const north = parseFloat(hit.boundingbox[1]);
    const west = parseFloat(hit.boundingbox[2]);
    const east = parseFloat(hit.boundingbox[3]);
    if (![south, north, west, east].every(Number.isFinite)) return;
    const next: BrowseBbox = [west, south, east, north];
    setBbox(next);
    mapRef.current?.flyToBbox(next);
  }

  const projectParked = currentProjectId != null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Title bar */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--color-line)] bg-[var(--color-surface-raised)] px-4 py-2">
        <div className="flex items-center gap-3">
          {projectParked && (
            <button
              type="button"
              onClick={() => setMode("project")}
              className="text-xs uppercase tracking-wider text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
              title={`Back to ${currentProject?.name ?? "project"}`}
            >
              ← Back to project
            </button>
          )}
          {!projectParked && (
            <button
              type="button"
              onClick={() => setMode("project")}
              className="text-xs uppercase tracking-wider text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            >
              ← All projects
            </button>
          )}
          <span className="text-[var(--color-line)]">·</span>
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-accent)]">
              RECON
            </span>
            <h1 className="font-[var(--font-display)] text-base text-[var(--color-ink)]">
              Field Atlas
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-ink-faint)]">
          See what OSM knows about an area.
        </div>
      </header>

      {/* Body grid — map left/centre, rail right. */}
      <div
        className="grid min-h-0 flex-1 grid-cols-[1fr_400px] overflow-hidden"
        style={{ gridTemplateRows: "minmax(0, 1fr)" }}
      >
        <main className="relative min-h-0 min-w-0 overflow-hidden bg-[#eae6dc]">
          {/* Map */}
          <BrowseMap
            ref={mapRef}
            bbox={bbox}
            items={mapItems}
            hoveredOsmId={hoveredFeatureId}
            selectedOsmId={selectedFeatureId}
            onFeatureClick={(osmId) => setSelectedFeatureId(osmId)}
          />

          {/* Command strip — overlaid on the map. */}
          <CommandStrip
            bbox={bbox}
            onSearchPick={onSearchPick}
            onUseViewport={captureViewport}
            onRefetch={() => bbox && void fetchInventory(bbox)}
            inventoryLoading={inventoryLoading}
            totalCount={inventory?.total_count ?? null}
            areaKm2={inventory?.area_km2 ?? null}
          />
        </main>

        <aside className="min-h-0 min-w-0 overflow-x-hidden border-l border-[var(--color-line)] bg-[var(--color-surface-raised)]">
          {!bbox ? (
            <EmptyState />
          ) : selectedFeatureId ? (
            <FeatureDetail
              osmId={selectedFeatureId}
              bbox={bbox}
              onBack={() => setSelectedFeatureId(null)}
              onOpenBake={(prefill) => setBakeOpen({ prefill })}
            />
          ) : (
            <InventoryRail
              bbox={bbox}
              inventory={inventory}
              inventoryLoading={inventoryLoading}
              inventoryError={inventoryError}
              inventoryFetchedAt={inventoryFetchedAt}
              hoveredOsmId={hoveredFeatureId}
              selectedOsmId={selectedFeatureId}
              onHoverItem={setHoveredFeatureId}
              onSelectItem={(osmId) => setSelectedFeatureId(osmId)}
              onRefetch={() => bbox && void fetchInventory(bbox)}
            />
          )}
        </aside>
      </div>

      {bakeOpen && (
        <BakeHandoffModal
          prefill={bakeOpen.prefill}
          open={true}
          onClose={() => setBakeOpen(null)}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// CommandStrip — overlaid on the map; carries the bbox-pick affordances.
// ────────────────────────────────────────────────────────────────────────────

function CommandStrip({
  bbox,
  onSearchPick,
  onUseViewport,
  onRefetch,
  inventoryLoading,
  totalCount,
  areaKm2,
}: {
  bbox: BrowseBbox | null;
  onSearchPick: (hit: NominatimHit) => void;
  onUseViewport: () => void;
  onRefetch: () => void;
  inventoryLoading: boolean;
  totalCount: number | null;
  areaKm2: number | null;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<NominatimHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`;
      const resp = await fetch(url, {
        headers: { "Accept-Language": "en", "User-Agent": "overpass-styler/1.0" },
      });
      if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
      const data = (await resp.json()) as NominatimHit[];
      setHits(data);
    } catch (e) {
      setSearchError(String(e));
      setHits([]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 flex justify-center px-3 pt-3">
      <div className="pointer-events-auto flex w-full max-w-2xl flex-col gap-1.5">
        <div className="flex items-center gap-2 rounded-md border border-[var(--color-line)] bg-white/95 px-2 py-1.5 shadow-sm">
          <TextInput
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="Search a place name (Mariupol, Khartoum, …)"
            className="border-none bg-transparent px-1 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void search();
              }
            }}
          />
          <Button size="sm" onClick={() => void search()} disabled={searching || !q.trim()}>
            {searching ? "…" : "Search"}
          </Button>
          <div className="h-4 w-px bg-[var(--color-line)]" aria-hidden="true" />
          <Button
            size="sm"
            variant="ghost"
            disabled
            title="Draw-on-map is coming soon. Use Search or Use viewport for now."
          >
            Draw area
          </Button>
          <Button size="sm" variant="ghost" onClick={onUseViewport}>
            Use viewport
          </Button>
        </div>

        {/* Search dropdown */}
        {hits.length > 0 && (
          <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-white/95 shadow-sm">
            <ul className="max-h-60 overflow-y-auto">
              {hits.map((h, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => {
                      onSearchPick(h);
                      setHits([]);
                      setQ("");
                    }}
                    className="block w-full truncate px-3 py-1.5 text-left text-[11px] text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)]"
                    title={h.display_name}
                  >
                    {h.display_name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {searchError && (
          <div className="rounded-md border border-[var(--color-danger)]/40 bg-white/95 px-2 py-1 text-[11px] text-[var(--color-danger)] shadow-sm">
            {searchError}
          </div>
        )}

        {/* Status strip — area, count, refetch */}
        {bbox && (
          <div className="flex items-center gap-3 rounded-md border border-[var(--color-line)] bg-white/95 px-3 py-1.5 text-[11px] text-[var(--color-ink-soft)] shadow-sm">
            {areaKm2 != null && (
              <span>
                <span className="text-[var(--color-ink-faint)]">Area</span>{" "}
                <span className="font-[var(--font-mono)] text-[var(--color-ink)]">
                  {areaKm2.toFixed(1)} km²
                </span>
              </span>
            )}
            {totalCount != null && (
              <span>
                <span className="text-[var(--color-ink-faint)]">Features</span>{" "}
                <span className="font-[var(--font-mono)] text-[var(--color-ink)]">
                  {totalCount.toLocaleString()}
                </span>
              </span>
            )}
            <button
              type="button"
              onClick={onRefetch}
              disabled={inventoryLoading}
              className="ml-auto rounded-md border border-[var(--color-line)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {inventoryLoading ? "…" : "Refetch"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-xs space-y-3">
        <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-accent)]">
          Recon
        </div>
        <h2 className="font-[var(--font-display)] text-lg text-[var(--color-ink)]">
          Pick an area to begin.
        </h2>
        <p className="text-xs leading-relaxed text-[var(--color-ink-soft)]">
          Search a place name in the top bar, or pan/zoom the map to your
          area of interest and click <strong>Use viewport</strong>. The
          inventory rail will populate with every domain OSM knows about.
        </p>
      </div>
    </div>
  );
}
