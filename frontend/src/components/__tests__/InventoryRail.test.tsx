/** Smoke tests for InventoryRail.
 *
 * Covers the three rail states: loading, domain-cards (normal inventory),
 * and area-capped. We mock api.browse.items so the drill-in view does not
 * hit Overpass during tests.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InventoryRail } from "@/components/InventoryRail";
import type { BrowseBbox, BrowseInventoryResponse } from "@/lib/types";

// Mock the api module — the drill-in view fetches items lazily; the unit
// tests below never enter that view, but the mock guards against accidental
// network access in CI.
vi.mock("@/lib/api", () => ({
  api: {
    browse: {
      items: vi.fn(),
    },
  },
}));

const BBOX: BrowseBbox = [37.5, 47.5, 37.7, 47.6];

function makeInventory(overrides: Partial<BrowseInventoryResponse> = {}): BrowseInventoryResponse {
  return {
    area_capped: false,
    area_km2: 12.3,
    area_cap_km2: 200,
    total_count: 47,
    summary: { bbox: BBOX, total_count: 47 },
    domains: [
      {
        name: "Amenities",
        count: 14,
        top_tags: [
          { key: "amenity", value: "prison", count: 6 },
          { key: "amenity", value: "school", count: 4 },
        ],
        tags: [
          { key: "amenity", value: "prison", count: 6 },
          { key: "amenity", value: "school", count: 4 },
        ],
      },
      {
        name: "Buildings",
        count: 22,
        top_tags: [{ key: "building", value: "yes", count: 18 }],
        tags: [{ key: "building", value: "yes", count: 18 }],
      },
    ],
    domain_counts: null,
    centers: [],
    ...overrides,
  };
}

describe("InventoryRail", () => {
  it("renders a loading hint while inventory is in flight", () => {
    render(
      <InventoryRail
        bbox={BBOX}
        inventory={null}
        inventoryLoading={true}
        inventoryError={null}
        inventoryFetchedAt={null}
        hoveredOsmId={null}
        selectedOsmId={null}
        drill={null}
        onDrillChange={() => {}}
        onHoverItem={() => {}}
        onSelectItem={() => {}}
        onRefetch={() => {}}
      />,
    );
    expect(screen.getByText(/Querying Overpass/i)).toBeTruthy();
  });

  it("renders domain cards for a non-capped inventory", () => {
    render(
      <InventoryRail
        bbox={BBOX}
        inventory={makeInventory()}
        inventoryLoading={false}
        inventoryError={null}
        inventoryFetchedAt={Date.now()}
        hoveredOsmId={null}
        selectedOsmId={null}
        drill={null}
        onDrillChange={() => {}}
        onHoverItem={() => {}}
        onSelectItem={() => {}}
        onRefetch={() => {}}
      />,
    );
    expect(screen.getByText("Amenities")).toBeTruthy();
    expect(screen.getByText("Buildings")).toBeTruthy();
    // Top-tag chips render with their value + count badge.
    expect(screen.getByTitle("amenity=prison · 6")).toBeTruthy();
  });

  it("renders the area-capped notice when the bbox is too large", () => {
    const capped = makeInventory({
      area_capped: true,
      area_km2: 850,
      summary: null,
      domains: null,
      domain_counts: { Amenities: 1200, Buildings: 9500 },
    });
    render(
      <InventoryRail
        bbox={BBOX}
        inventory={capped}
        inventoryLoading={false}
        inventoryError={null}
        inventoryFetchedAt={Date.now()}
        hoveredOsmId={null}
        selectedOsmId={null}
        drill={null}
        onDrillChange={() => {}}
        onHoverItem={() => {}}
        onSelectItem={() => {}}
        onRefetch={() => {}}
      />,
    );
    expect(screen.getByText(/Area too large/i)).toBeTruthy();
    expect(screen.getByText("Amenities")).toBeTruthy();
    expect(screen.getByText("9,500")).toBeTruthy();
  });

  it("filters domain cards via the search box", () => {
    render(
      <InventoryRail
        bbox={BBOX}
        inventory={makeInventory()}
        inventoryLoading={false}
        inventoryError={null}
        inventoryFetchedAt={Date.now()}
        hoveredOsmId={null}
        selectedOsmId={null}
        drill={null}
        onDrillChange={() => {}}
        onHoverItem={() => {}}
        onSelectItem={() => {}}
        onRefetch={() => {}}
      />,
    );
    const search = screen.getByPlaceholderText(/Filter domains/i) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "build" } });
    expect(screen.queryByText("Amenities")).toBeNull();
    expect(screen.getByText("Buildings")).toBeTruthy();
  });

  it("fires onRefetch when the refetch button is clicked", () => {
    const onRefetch = vi.fn();
    render(
      <InventoryRail
        bbox={BBOX}
        inventory={makeInventory()}
        inventoryLoading={false}
        inventoryError={null}
        inventoryFetchedAt={Date.now()}
        hoveredOsmId={null}
        selectedOsmId={null}
        drill={null}
        onDrillChange={() => {}}
        onHoverItem={() => {}}
        onSelectItem={() => {}}
        onRefetch={onRefetch}
      />,
    );
    fireEvent.click(screen.getByText("Refetch"));
    expect(onRefetch).toHaveBeenCalledTimes(1);
  });
});
