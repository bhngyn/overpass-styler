/** Build a tinted `ImageBitmap` for use as a MapLibre symbol icon.
 *
 * Mirrors Earth Pro's IconStyle semantics: the user-chosen `color` is
 * multiplied with the icon's pixel RGB. White silhouettes (atrocity / HR)
 * become the chosen colour; pre-coloured Google paddles pass through when the
 * tint is white and darken proportionally otherwise.
 *
 * Why canvas rather than MapLibre `icon-color`: that paint property only
 * works on SDF icons, and our mixed catalogue (raster paddles + raster
 * silhouettes) isn't SDF. Pre-tinting on a canvas matches Earth Pro pixel
 * for pixel and keeps the symbol layer plain raster.
 *
 * Cross-origin images (Google's hosted KML icons) may taint the canvas. We
 * fall back to the untinted ImageBitmap in that case — the icon still shows,
 * just without the tint applied. Same-origin bundled icons always tint
 * cleanly. */

import type { RGBA } from "./kmlColor";

/** KML scale=1 should render at roughly Earth Pro's default pin size. We
 * normalise every bitmap to this logical pixel size by setting `pixelRatio`
 * proportional to the source image's native dimensions. */
const ICON_LOGICAL_PX = 24;

export interface PreparedIcon {
  image: ImageBitmap | HTMLImageElement;
  /** Use with `map.addImage(id, image, { pixelRatio })`. */
  pixelRatio: number;
}

/** Load `href` (with `crossOrigin = "anonymous"` so the canvas isn't tainted
 * when CORS headers are present), then return a tinted bitmap suitable for
 * `map.addImage`. */
export async function buildTintedIcon(
  href: string,
  color: RGBA,
): Promise<PreparedIcon> {
  const img = await loadImage(href);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  // Match the icon's natural shape with `ICON_LOGICAL_PX` on its longest side.
  const longest = Math.max(w, h);
  const pixelRatio = longest > 0 ? longest / ICON_LOGICAL_PX : 1;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { image: img, pixelRatio };

    // Step 1: lay down the icon (preserves source RGB and source alpha).
    ctx.drawImage(img, 0, 0);

    // Step 2: multiply by the tint RGB. This is KML's IconStyle/color
    // semantics — white pixels pick up the tint, dark pixels stay dark.
    // Note: multiply mode on a canvas with a solid fill leaves alpha = 1
    // everywhere, which we fix in step 3.
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    ctx.fillRect(0, 0, w, h);

    // Step 3: restore the original alpha mask, scaled by the tint's alpha.
    ctx.globalCompositeOperation = "destination-in";
    ctx.globalAlpha = color.a / 255;
    ctx.drawImage(img, 0, 0);
    ctx.globalAlpha = 1;

    const bitmap = await createImageBitmap(canvas);
    return { image: bitmap, pixelRatio };
  } catch {
    // Tainted canvas (cross-origin image without CORS headers) — fall back
    // to the untinted image so the icon at least shows up.
    return { image: img, pixelRatio };
  }
}

function loadImage(href: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load icon: ${href}`));
    img.src = href;
  });
}

/** Stable cache key for an (href, color) pair. Embed both so a category that
 * keeps the same icon but switches colour invalidates correctly. */
export function iconCacheKey(href: string, color: RGBA): string {
  return `${href}|${color.r},${color.g},${color.b},${color.a}`;
}
