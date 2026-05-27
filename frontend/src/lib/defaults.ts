import type { FeatureStyle } from "./types";

export const DEFAULT_ICON_HREF = "http://maps.google.com/mapfiles/kml/paddle/ylw-blank.png";

/** Sensible starting style for a new category — semi-transparent grey fill, solid
 * outline, yellow paddle. Distinct enough to see on the map; quiet enough not to
 * feel decided before the investigator has tweaked it. */
export const defaultFeatureStyle = (): FeatureStyle => ({
  polygon: {
    fill: true,
    fill_color: { r: 127, g: 127, b: 127, a: 127 },
    outline: true,
    outline_color: { r: 30, g: 30, b: 30, a: 255 },
    outline_width: 1.5,
  },
  icon: {
    icon_href: DEFAULT_ICON_HREF,
    color: { r: 255, g: 255, b: 255, a: 255 },
    scale: 1.0,
    heading: 0,
  },
  label: {
    show: true,
    color: { r: 255, g: 255, b: 255, a: 255 },
    scale: 1.0,
  },
});

/** A small palette of starting colors the investigator can click through quickly. */
export const STARTER_PALETTE: ReadonlyArray<[string, string]> = [
  ["red", "#c1352d"],
  ["orange", "#d97a2b"],
  ["yellow", "#d8b21f"],
  ["green", "#3f7a3d"],
  ["teal", "#2f6f6f"],
  ["blue", "#2f4f8a"],
  ["purple", "#5e3a82"],
  ["graphite", "#3a3a3a"],
];
