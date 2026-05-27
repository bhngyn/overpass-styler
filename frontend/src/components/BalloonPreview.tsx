// Approximate preview; the canonical balloon is produced server-side by
// `backend/app/kml/balloon.py`. We mirror its HTML/CSS shape closely enough
// that an investigator can tell at a glance how Earth Pro will render a
// clicked placemark — but we substitute the placemark's real annotations
// and OSM tags inline instead of leaving Earth Pro substitution tokens
// (`$[name]`, `$[hr:source_url]`, …) for the user to mentally fill in.
//
// The HTML lives inside a sandboxed `<iframe srcDoc>` so the balloon's
// `<style>` block can't bleed into the host page, and any future user-
// supplied annotation content can't escape the frame. The frame is given
// `sandbox="allow-popups"` so investigators can still click through links
// (e.g. an investigator's source-URL pointing at bellingcat.com) into a
// new browser tab.
//
// Pairs visually with the Review step's design tokens (paper-cream, ink
// dark, single teal accent) and with the export balloon — keep the two
// in lockstep when either is restyled.

import { useMemo } from "react";
import type { FeatureStyle, PlacemarkPreview } from "@/lib/types";

interface BalloonPreviewProps {
  style: FeatureStyle;
  placemark: PlacemarkPreview;
  /** Human-readable category label (e.g. ``amenity=prison`` or
   * ``Detention facility``). Rendered in the small-caps eyebrow. */
  categoryLabel: string;
  /** Height in px; defaults to 380 to match the plan's spec. */
  height?: number;
}

/** OSM tag keys the backend balloon emits as fixed rows. Mirroring the
 * server-side list keeps the preview's vertical rhythm consistent with the
 * exported balloon. Missing tags render as a blank value cell, exactly as
 * Earth Pro does when a `$[key]` substitution has no match. */
const DEFAULT_OSM_TAG_KEYS = [
  "amenity",
  "landuse",
  "building",
  "operator",
  "name:en",
  "addr:city",
  "addr:country",
  "start_date",
  "wikipedia",
] as const;

/** Investigator annotation keys, in the same canonical order as the export
 * balloon. Any annotation present on the placemark whose key isn't in this
 * list is appended in insertion order. */
const DEFAULT_ANNOTATION_KEYS = [
  "source_url",
  "date",
  "confidence",
  "note",
] as const;

export function BalloonPreview({
  style,
  placemark,
  categoryLabel,
  height = 380,
}: BalloonPreviewProps) {
  const html = useMemo(
    () => buildBalloonHtml({ style, placemark, categoryLabel }),
    [style, placemark, categoryLabel],
  );

  return (
    <iframe
      title="Balloon preview"
      srcDoc={html}
      sandbox="allow-popups"
      style={{
        border: "1px solid var(--color-line)",
        borderRadius: 8,
        width: "100%",
        height,
        display: "block",
        background: "#fafaf6",
      }}
    />
  );
}

function buildBalloonHtml({
  style,
  placemark,
  categoryLabel,
}: {
  style: FeatureStyle;
  placemark: PlacemarkPreview;
  categoryLabel: string;
}): string {
  const name = placemark.name ?? `Placemark #${placemark.index}`;
  const iconHref = style.icon.icon_href || null;

  // Annotations — preserve canonical order, then append any extras.
  const annotationsMap = placemark.annotations ?? {};
  const seenKeys = new Set<string>();
  const annotationKeys: string[] = [];
  for (const k of DEFAULT_ANNOTATION_KEYS) {
    annotationKeys.push(k);
    seenKeys.add(k);
  }
  for (const k of Object.keys(annotationsMap)) {
    if (!seenKeys.has(k)) {
      annotationKeys.push(k);
      seenKeys.add(k);
    }
  }

  const evidenceRows = annotationKeys
    .map((key, idx) => {
      const raw = annotationsMap[key] ?? "";
      const value = renderEvidenceValue(key, raw);
      return renderKvRow(humanizeKey(key), value, idx % 2 === 1);
    })
    .join("\n");

  const osmTagsRows = DEFAULT_OSM_TAG_KEYS.map((key, idx) => {
    const raw = placemark.extended_data?.[key] ?? "";
    return renderKvRow(humanizeKey(key), escapeHtml(raw), idx % 2 === 1);
  }).join("\n");

  const coords = pickFirstCoord(placemark);
  const coordsLabel = coords
    ? `${formatLat(coords[1])}, ${formatLon(coords[0])}`
    : "";
  const osmId = placemark.extended_data?.["@id"] ?? null;
  const osmUrl = osmId
    ? `https://www.openstreetmap.org/${encodeURIComponent(osmId)}`
    : "https://www.openstreetmap.org/";

  const eyebrowIcon = iconHref
    ? `<img src="${escapeAttr(absolutizeUrl(iconHref))}" alt="" />`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Balloon preview</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #fafaf6;
  }
  body, .hr-balloon {
    font-family: -apple-system, "system-ui", "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    padding: 14px 16px;
    max-width: 380px;
    line-height: 1.4;
  }
  .hr-eyebrow {
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #2a5d6b;
    margin: 0 0 4px 0;
  }
  .hr-eyebrow img {
    width: 12px;
    height: 12px;
    vertical-align: -2px;
    margin-right: 4px;
  }
  .hr-title {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 20px;
    font-weight: 600;
    margin: 6px 0 4px 0;
    color: #1a1a1a;
  }
  .hr-rule {
    border: none;
    border-top: 1px solid #d8d2c0;
    margin: 8px 0 10px 0;
  }
  .hr-section {
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #2a5d6b;
    margin: 14px 0 6px 0;
    padding-bottom: 3px;
    border-bottom: 1px solid #e0d8c0;
  }
  table.hr-kv {
    border-collapse: collapse;
    font-size: 12px;
    width: 100%;
    margin: 0;
  }
  table.hr-kv td {
    padding: 3px 6px;
    vertical-align: top;
  }
  table.hr-kv td.hr-k {
    color: #6a6a6a;
    padding-right: 12px;
    width: 40%;
    white-space: nowrap;
  }
  table.hr-kv tr.hr-alt td {
    background: #f4f1e8;
  }
  .hr-empty {
    color: #b8b3a3;
    font-style: italic;
  }
  .hr-footer {
    font-size: 10px;
    color: #8a8a8a;
    margin-top: 14px;
    border-top: 1px solid #e0d8c0;
    padding-top: 6px;
  }
  .hr-footer a, a {
    color: #2a5d6b;
  }
</style>
</head>
<body>
<div class="hr-balloon">
  <div class="hr-eyebrow">${eyebrowIcon}${escapeHtml(categoryLabel || "Feature")}</div>
  <h1 class="hr-title">${escapeHtml(name)}</h1>
  <hr class="hr-rule" />
  <div class="hr-section">Evidence</div>
  <table class="hr-kv">
${evidenceRows}
  </table>
  <div class="hr-section">OSM tags</div>
  <table class="hr-kv">
${osmTagsRows}
  </table>
  <div class="hr-footer">
    ${coordsLabel ? `${escapeHtml(coordsLabel)} &middot; ` : ""}<a href="${escapeAttr(osmUrl)}" target="_blank" rel="noreferrer">view on OSM &#8599;</a>
  </div>
</div>
</body>
</html>`;
}

function renderKvRow(label: string, valueHtml: string, alt: boolean): string {
  const cls = alt ? ' class="hr-alt"' : "";
  const cell = valueHtml.trim().length > 0
    ? valueHtml
    : '<span class="hr-empty">—</span>';
  return `    <tr${cls}><td class="hr-k">${escapeHtml(label)}</td><td>${cell}</td></tr>`;
}

/** Mirror of backend `_humanize_key`. Keep keys in lockstep with balloon.py. */
function humanizeKey(key: string): string {
  const overrides: Record<string, string> = {
    source_url: "Source",
    source: "Source",
    date: "Date",
    confidence: "Confidence",
    note: "Note",
    "name:en": "Name (en)",
    "addr:city": "City",
    "addr:country": "Country",
    start_date: "Start date",
  };
  if (overrides[key]) return overrides[key];
  const cleaned = key.replace(/_/g, " ").replace(/:/g, " ").trim();
  return cleaned.length === 0
    ? key
    : cleaned.slice(0, 1).toUpperCase() + cleaned.slice(1);
}

/** Render the value cell for an evidence row — linkify URL-shaped values and
 * special-case `confidence` as filled/empty dots (1–4 scale). */
function renderEvidenceValue(field: string, rawValue: string): string {
  if (!rawValue) return "";
  const value = rawValue.trim();
  const lowered = field.toLowerCase();

  if (field === "confidence" || lowered === "confidence") {
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 4) {
      const dots = "●●●●○○○○".slice(4 - n, 4 - n + 4);
      return `<span title="confidence ${n}/4">${escapeHtml(dots)}</span>`;
    }
    return escapeHtml(value);
  }

  if (lowered.includes("url") || lowered === "source" || lowered === "link") {
    if (/^https?:\/\//i.test(value)) {
      return `<a href="${escapeAttr(value)}" target="_blank" rel="noreferrer">${escapeHtml(
        truncate(value, 48),
      )}</a>`;
    }
  }

  return escapeHtml(value);
}

/** Pick the first coordinate pair from any geometry. Robust to nested rings.
 * Returns `[lon, lat]` or null. */
function pickFirstCoord(placemark: PlacemarkPreview): [number, number] | null {
  const g = placemark.geometry;
  if (!g) return null;
  if (g.kind === "Point") {
    const coords = g.coords as [number, number] | undefined;
    if (coords && coords.length >= 2) return [coords[0], coords[1]];
  } else if (g.kind === "LineString") {
    const coords = g.coords as [number, number][] | undefined;
    if (coords && coords[0]) return [coords[0][0], coords[0][1]];
  } else if (g.kind === "Polygon") {
    const rings = g.coords as [number, number][][] | undefined;
    if (rings && rings[0] && rings[0][0]) return [rings[0][0][0], rings[0][0][1]];
  }
  return null;
}

function formatLat(lat: number): string {
  const hemi = lat >= 0 ? "N" : "S";
  return `${Math.abs(lat).toFixed(4)}°${hemi}`;
}

function formatLon(lon: number): string {
  const hemi = lon >= 0 ? "E" : "W";
  return `${Math.abs(lon).toFixed(4)}°${hemi}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Resolve relative `/api/icons/...` URLs to absolute so they work inside the
 * iframe's `srcdoc` document (which has its own base URL). */
function absolutizeUrl(href: string): string {
  if (/^https?:\/\//i.test(href) || href.startsWith("data:")) return href;
  if (typeof window !== "undefined") {
    try {
      return new URL(href, window.location.origin).toString();
    } catch {
      return href;
    }
  }
  return href;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
