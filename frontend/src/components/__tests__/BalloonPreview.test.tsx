/** Smoke test for BalloonPreview — verifies it renders an iframe with the
 * expected substitutions (name, category eyebrow, annotation value) without
 * throwing. The iframe's *internal* DOM isn't asserted (jsdom doesn't
 * execute `srcDoc` content the way a browser does); we instead pull the
 * srcDoc attribute and string-match against it, which is plenty for a v1
 * sanity check. */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { BalloonPreview } from "@/components/BalloonPreview";
import { defaultFeatureStyle } from "@/lib/defaults";
import type { PlacemarkPreview } from "@/lib/types";

function makePlacemark(overrides: Partial<PlacemarkPreview> = {}): PlacemarkPreview {
  return {
    index: 0,
    name: "Olenivka penal colony",
    category_value: "prison",
    extended_data: {
      "@id": "node/12345",
      amenity: "prison",
      operator: "DPR administration",
      "addr:city": "Olenivka",
    },
    extended_data_order: ["@id", "amenity", "operator", "addr:city"],
    geometry: { kind: "Point", coords: [37.7384, 47.5621] },
    annotations: {
      source_url: "https://www.bellingcat.com/example",
      date: "2022-07-29",
      confidence: "3",
      note: "Reported shelling of barracks; cross-corroborated by satellite imagery.",
    },
    has_override: false,
    ...overrides,
  };
}

describe("BalloonPreview", () => {
  it("renders an iframe with the placemark name and category eyebrow", () => {
    const { container } = render(
      <BalloonPreview
        style={defaultFeatureStyle()}
        placemark={makePlacemark()}
        categoryLabel="amenity=prison"
      />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const srcDoc = iframe?.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("Olenivka penal colony");
    expect(srcDoc).toContain("amenity=prison");
    // Annotation values are inlined as real HTML, not Earth Pro tokens.
    expect(srcDoc).toContain("2022-07-29");
    expect(srcDoc).toContain("DPR administration");
    expect(srcDoc).not.toContain("$[name]");
  });

  it("linkifies an https source_url annotation", () => {
    const { container } = render(
      <BalloonPreview
        style={defaultFeatureStyle()}
        placemark={makePlacemark()}
        categoryLabel="amenity=prison"
      />,
    );
    const srcDoc = container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toMatch(/href="https:\/\/www\.bellingcat\.com\/example"/);
  });

  it("falls back to a generic title when the placemark has no name", () => {
    const { container } = render(
      <BalloonPreview
        style={defaultFeatureStyle()}
        placemark={makePlacemark({ name: null, index: 7 })}
        categoryLabel="landuse=cemetery"
      />,
    );
    const srcDoc = container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("Placemark #7");
  });

  it("renders without throwing when annotations are empty", () => {
    expect(() =>
      render(
        <BalloonPreview
          style={defaultFeatureStyle()}
          placemark={makePlacemark({ annotations: {} })}
          categoryLabel="amenity=prison"
        />,
      ),
    ).not.toThrow();
  });
});
