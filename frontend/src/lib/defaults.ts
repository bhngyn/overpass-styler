import type { FeatureStyle } from "./types";

/** Default icon href: the neutral incident pin from the atrocity palette.
 * Distinct enough to read on any basemap; symbolic rather than literal. */
export const DEFAULT_ICON_HREF = "/api/icons/atrocity/incident-marker.png";

/** Sensible starting style for a new category — semi-transparent grey fill, solid
 * outline, neutral incident-marker icon. Distinct enough to see on the map;
 * quiet enough not to feel decided before the investigator has tweaked it. */
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

/** Curated starter icons from the atrocity palette — surfaced as quick-pick
 * shortcuts elsewhere in the UI so investigators don't have to open the full
 * picker for the eight most common categories. */
export const STARTER_ICON_HREFS: ReadonlyArray<string> = [
  "/api/icons/atrocity/detention-facility.png",
  "/api/icons/atrocity/mass-grave.png",
  "/api/icons/atrocity/destroyed-building.png",
  "/api/icons/atrocity/hospital.png",
  "/api/icons/atrocity/school.png",
  "/api/icons/atrocity/religious-site.png",
  "/api/icons/atrocity/witness.png",
  "/api/icons/atrocity/incident-marker.png",
];
