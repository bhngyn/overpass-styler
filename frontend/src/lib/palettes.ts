/** Categorical color palettes for auto-assigning distinct colors to layers.
 *
 * The default ("Tol Bright") is Paul Tol's qualitative palette — designed to
 * be distinguishable both for people with normal vision and for the common
 * forms of colorblindness. Use it unless the investigator has a specific
 * cartographic preference.
 *
 * Each theme also carries a default polygon fill alpha — themes intended for
 * dense overlay (e.g. cemeteries blanketing a town) use lower alpha so layers
 * can be read through each other.
 */

export interface Theme {
  id: string;
  name: string;
  description: string;
  polyAlpha: number; // 0..1 default polygon fill opacity for this theme
  colors: readonly string[]; // hex strings, no '#' optional
}

export const THEMES: readonly Theme[] = [
  {
    id: "tol-bright",
    name: "Tol Bright",
    description:
      "Colorblind-safe qualitative palette by Paul Tol. Maximum distinction for categorical data; the default.",
    polyAlpha: 0.5,
    colors: [
      "#4477AA", "#EE6677", "#228833", "#CCBB44",
      "#66CCEE", "#AA3377", "#BBBBBB", "#000000",
    ],
  },
  {
    id: "earth",
    name: "Earth tones",
    description:
      "Warm, naturalistic palette. Reads well on terrain and satellite basemaps.",
    polyAlpha: 0.45,
    colors: [
      "#a85d2d", "#6b8e3d", "#d4a64a", "#5e7080",
      "#a64d4d", "#7d5a8f", "#8a7654", "#3e6c5b",
    ],
  },
  {
    id: "vibrant",
    name: "Vibrant",
    description:
      "High-saturation palette. Use when each category needs to pop hard.",
    polyAlpha: 0.55,
    colors: [
      "#ee3333", "#ff8800", "#ffcc00", "#33aa33",
      "#3377ee", "#9933cc", "#ff3399", "#00aa88",
    ],
  },
  {
    id: "subdued",
    name: "Subdued greys",
    description:
      "Restrained greyscale. Use when one category should stand out with a custom color and the rest should recede.",
    polyAlpha: 0.4,
    colors: [
      "#5a5a5a", "#7a7a7a", "#9a9a9a", "#3a3a3a",
      "#8b837a", "#a89e93", "#6c6259", "#bdb4a7",
    ],
  },
];

export const DEFAULT_THEME_ID = "tol-bright";

export const themeById = (id: string): Theme =>
  THEMES.find((t) => t.id === id) ?? THEMES[0];

/** Return the i-th colour, wrapping if more categories than palette slots. */
export const colorAt = (theme: Theme, index: number): string =>
  theme.colors[((index % theme.colors.length) + theme.colors.length) % theme.colors.length];
