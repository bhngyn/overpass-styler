/* Color helper tests. Shared vectors with backend/tests/test_color.py — keep both
 * in sync. If you change one, change both. */

import { describe, expect, it } from "vitest";
import {
  alphaToOpacity,
  hexRgbToRgba,
  kmlToRgba,
  opacityToAlpha,
  rgba,
  rgbaToHexRgb,
  rgbaToKml,
} from "./kmlColor";

const VECTORS: Array<{ rgba: ReturnType<typeof rgba>; kml: string; hex: string }> = [
  { rgba: rgba(255, 0, 0, 255), kml: "ff0000ff", hex: "#ff0000" },
  { rgba: rgba(0, 255, 0, 255), kml: "ff00ff00", hex: "#00ff00" },
  { rgba: rgba(0, 0, 255, 255), kml: "ffff0000", hex: "#0000ff" },
  { rgba: rgba(255, 165, 0, 127), kml: "7f00a5ff", hex: "#ffa500" },
  { rgba: rgba(0, 0, 0, 0), kml: "00000000", hex: "#000000" },
  { rgba: rgba(255, 255, 255, 255), kml: "ffffffff", hex: "#ffffff" },
];

describe("KML color helpers", () => {
  it.each(VECTORS)("rgbaToKml($rgba) === $kml", ({ rgba: c, kml }) => {
    expect(rgbaToKml(c)).toBe(kml);
  });

  it.each(VECTORS)("kmlToRgba($kml) round-trip", ({ rgba: c, kml }) => {
    expect(kmlToRgba(kml)).toEqual(c);
  });

  it.each(VECTORS)("hex <-> rgba round-trip", ({ rgba: c, hex }) => {
    expect(hexRgbToRgba(hex, c.a)).toEqual(c);
    expect(rgbaToHexRgb(c)).toBe(hex);
  });

  it("opacity <-> alpha is round-trippable within 1/255", () => {
    for (const o of [0, 0.25, 0.5, 0.75, 1]) {
      const a = opacityToAlpha(o);
      expect(Math.abs(alphaToOpacity(a) - o)).toBeLessThan(1 / 255);
    }
  });

  it("rejects invalid input", () => {
    expect(() => rgba(300, 0, 0)).toThrow();
    expect(() => kmlToRgba("notahex!")).toThrow();
    expect(() => hexRgbToRgba("#zzz")).toThrow();
    expect(() => opacityToAlpha(1.5)).toThrow();
  });
});
