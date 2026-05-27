/**
 * Per-session outbound-network consent gate.
 *
 * Per the privacy contract in CLAUDE.md, outbound requests to overpass-api.de,
 * Taginfo, Nominatim, etc. are opt-in: the investigator must explicitly
 * confirm the first time per session, after which we don't ask again until
 * the page reloads.
 *
 * Three separate consent surfaces exist (Compose, Tag Library, Browse) and
 * D3 review caught that Browse never had one. This module centralises the
 * gate so any new outbound-call surface can adopt the same contract by
 * importing one function.
 *
 * Consent is stored in ``sessionStorage`` keyed by a per-purpose label, so:
 *
 * * Accepting Overpass in Compose grants Compose for the session, but not
 *   Browse (different purpose).
 * * Reloading the page clears all consent — investigators get a fresh prompt.
 * * Each call site can subscribe to its own purpose. The Tag-Library drawer's
 *   existing ``overpass-styler:taginfo-consent`` key continues to work.
 */

const STORAGE_PREFIX = "overpass-styler:network-consent:";

/** Read the persisted decision for a purpose, if any. */
export function readConsent(
  purpose: string,
): "granted" | "denied" | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.sessionStorage.getItem(STORAGE_PREFIX + purpose);
    if (v === "granted" || v === "denied") return v;
  } catch {
    /* sessionStorage can throw in restrictive browser modes — treat as no consent */
  }
  return null;
}

/** Persist a decision so subsequent calls in the same session don't re-prompt. */
export function writeConsent(
  purpose: string,
  decision: "granted" | "denied",
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + purpose, decision);
  } catch {
    /* see readConsent — silent best-effort */
  }
}

/** Wipe a purpose's consent. Used when a "denied" decision should be
 * reversible mid-session (e.g. the Tag-Library "allow taginfo" affordance). */
export function clearConsent(purpose: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_PREFIX + purpose);
  } catch {
    /* silent */
  }
}
