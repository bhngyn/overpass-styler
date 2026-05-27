/**
 * KML color helpers — mirror of backend/app/kml/color.py.
 *
 * KML colors are AABBGGRR hex (alpha first, then blue/green/red). Opacity is the
 * high byte: 50%-transparent red = "7f0000ff". Diverging implementations between
 * front and back would be a silent bug — kmlColor.test.ts uses the exact same
 * vectors as the Python test suite.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clampChannel = (n: number) => {
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`channel out of range 0..255: ${n}`);
  }
  return n;
};

export const rgba = (r: number, g: number, b: number, a = 255): RGBA => ({
  r: clampChannel(r),
  g: clampChannel(g),
  b: clampChannel(b),
  a: clampChannel(a),
});

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

export const rgbaToKml = (c: RGBA): string =>
  `${hex2(c.a)}${hex2(c.b)}${hex2(c.g)}${hex2(c.r)}`;

export const kmlToRgba = (kml: string): RGBA => {
  const s = kml.trim().toLowerCase();
  if (s.length !== 8 || !/^[0-9a-f]{8}$/.test(s)) {
    throw new Error(`not a KML color (expected 8 hex chars AABBGGRR): ${kml}`);
  }
  return {
    a: parseInt(s.slice(0, 2), 16),
    b: parseInt(s.slice(2, 4), 16),
    g: parseInt(s.slice(4, 6), 16),
    r: parseInt(s.slice(6, 8), 16),
  };
};

export const hexRgbToRgba = (hex: string, alpha = 255): RGBA => {
  const s = hex.trim().replace(/^#/, "").toLowerCase();
  if (s.length !== 6 || !/^[0-9a-f]{6}$/.test(s)) {
    throw new Error(`not a 6-digit hex RGB: ${hex}`);
  }
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
    a: clampChannel(alpha),
  };
};

export const rgbaToHexRgb = (c: RGBA): string =>
  `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

export const opacityToAlpha = (opacity: number): number => {
  if (opacity < 0 || opacity > 1) {
    throw new Error(`opacity must be 0..1: ${opacity}`);
  }
  return Math.round(opacity * 255);
};

export const alphaToOpacity = (alpha: number): number => {
  const a = clampChannel(alpha);
  return a / 255;
};

/** Convenience for use in CSS rules: `rgba(r, g, b, a)` */
export const rgbaToCss = (c: RGBA): string =>
  `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(3)})`;
