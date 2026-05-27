/**
 * TagLibraryDrawer — slide-in right-side panel that helps investigators find
 * the right OSM tag without leaving the Compose step.
 *
 * Layout: 720px wide on desktop (narrows on small viewports), three columns:
 *
 *   ┌─────────────┬─────────────┬───────────────────────┐
 *   │ Browse      │ Values      │ Detail                │
 *   │ (curated +  │ (key/value  │ (field note + wiki    │
 *   │  OSM keys)  │  rows, or   │  summary + insert)    │
 *   │             │  search)    │                       │
 *   └─────────────┴─────────────┴───────────────────────┘
 *
 * Selection state lives here so the three columns stay coordinated.
 *
 * Privacy contract:
 *  - The curated glossary is offline; first paint requires no confirmation.
 *  - Any Taginfo call (keys / values / tag / search) goes behind a
 *    once-per-session opt-in modal. The drawer remembers the answer for the
 *    rest of the session via ``sessionStorage``.
 *
 * Closing:
 *  - ESC key
 *  - Click on the backdrop (outside the panel)
 *  - The header's close affordance
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { GlossaryEntry } from "@/lib/tagLibrary.types";
import { TagDetailPanel } from "./TagDetailPanel";
import { TagLibraryBrowse } from "./TagLibraryBrowse";
import { TagLibraryValues } from "./TagLibraryValues";

const TAGINFO_CONSENT_KEY = "overpass-styler:taginfo-consent";

export interface TagLibraryDrawerProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called when the investigator confirms an insert action. The clause is
   * already in canonical Overpass syntax (e.g. ``["amenity"="prison"]`` or
   * ``nwr["amenity"="prison"]({{bbox}});``); the consumer decides where to
   * splice it (the Compose step does cursor-aware insertion in its QL
   * textarea).
   *
   * After firing this, the drawer closes itself — investigators almost
   * always want to verify what they inserted, and the drawer being open
   * would obscure the editor.
   */
  onInsert: (clause: string) => void;
}

interface Selection {
  /** Currently focused OSM key (null when the user is browsing curated only). */
  key: string | null;
  /** Currently focused value within ``key``. */
  value: string | null;
  /** Pre-loaded curated entry, when the user clicked from the Browse rail. */
  curated: GlossaryEntry | null;
}

const EMPTY_SELECTION: Selection = { key: null, value: null, curated: null };

export function TagLibraryDrawer({ open, onClose, onInsert }: TagLibraryDrawerProps) {
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  // The header's filter input. Drives the offline "All OSM tags" list in
  // the left rail; no longer feeds the Values column (which would have
  // fired a Taginfo /search call and rendered a confusing "no matches"
  // when the offline list already had the answer).
  const [searchInput, setSearchInput] = useState("");

  // Taginfo confirmation state. ``"granted" | "denied" | null``.
  const [consent, setConsent] = useState<"granted" | "denied" | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(TAGINFO_CONSENT_KEY);
    return raw === "granted" || raw === "denied" ? raw : null;
  });
  const [consentPending, setConsentPending] = useState(false);
  // Queue of resolvers waiting on the consent prompt. Several columns can fire
  // their fetch effects on the same tick (e.g. the user clicks a key while
  // also typing search) — we want them all to share one modal answer.
  const consentResolvers = useRef<Array<(ok: boolean) => void>>([]);

  // Reset selection + search when the drawer closes — opening it fresh is
  // less surprising than the last session's state lingering.
  useEffect(() => {
    if (!open) {
      setSelection(EMPTY_SELECTION);
      setSearchInput("");
    }
  }, [open]);

  // ESC closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Confirmation gateway. Curated callers can skip it; Taginfo callers MUST
  // await ``requireConfirmation()`` before firing a fetch. Returns ``true``
  // when the network call is allowed.
  const requireConfirmation = useCallback((): Promise<boolean> => {
    if (consent === "granted") return Promise.resolve(true);
    if (consent === "denied") return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      consentResolvers.current.push(resolve);
      setConsentPending(true);
    });
  }, [consent]);

  const resolveConsent = useCallback(
    (granted: boolean) => {
      const next = granted ? "granted" : "denied";
      setConsent(next);
      if (typeof window !== "undefined") {
        try {
          window.sessionStorage.setItem(TAGINFO_CONSENT_KEY, next);
        } catch {
          // sessionStorage may be unavailable (private mode); fail soft.
        }
      }
      const resolvers = consentResolvers.current;
      consentResolvers.current = [];
      setConsentPending(false);
      for (const r of resolvers) r(granted);
    },
    [],
  );

  const onSelectCurated = (entry: GlossaryEntry) => {
    if (entry.value) {
      setSelection({ key: entry.key, value: entry.value, curated: entry });
    } else {
      // Wildcard curated entry (key=*) — populate Values column with that key.
      setSelection({ key: entry.key, value: null, curated: entry });
    }
  };

  const onNavigateRelated = (key: string, value: string) => {
    setSelection({ key, value, curated: null });
  };

  const handleInsert = (clause: string) => {
    onInsert(clause);
    onClose();
  };

  // Compute what the Detail column should render. Three states:
  //  - both key+value: full panel
  //  - key only (no value, no search): a placeholder asking to pick a value
  //  - nothing: a calm "select something" view
  const detailContent = useMemo(() => {
    if (selection.key && selection.value) {
      return (
        <TagDetailPanel
          // Re-key on tag pair so the panel resets its internal fetch state
          // when the investigator navigates between tags.
          key={`${selection.key}=${selection.value}`}
          keyName={selection.key}
          value={selection.value}
          preloadedCurated={selection.curated}
          onInsert={handleInsert}
          onNavigate={onNavigateRelated}
          requireConfirmation={requireConfirmation}
        />
      );
    }
    if (selection.key) {
      return (
        <DetailEmpty
          headline="Pick a value"
          body={`Choose a value for "${selection.key}" in the middle column to see its details.`}
        />
      );
    }
    return (
      <DetailEmpty
        headline="Tag Library"
        body="Browse the curated entries on the left or pick an OSM key. Search across both with the bar above."
      />
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.key, selection.value, selection.curated, requireConfirmation]);

  return (
    <>
      {/* Backdrop. Pointer-events follow ``open`` so the underlying editor
          stays interactive when the drawer is closed (and the animation
          itself doesn't trap clicks). */}
      <div
        aria-hidden={!open}
        onClick={onClose}
        className={[
          "fixed inset-0 z-40 bg-[var(--color-ink)]/30 transition-opacity duration-200",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
      />

      {/* Drawer panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Tag Library"
        aria-hidden={!open}
        className={[
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-[720px] flex-col",
          "border-l border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl",
          "transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        {/* Header */}
        <header className="shrink-0 border-b border-[var(--color-line)] bg-[var(--color-surface-raised)] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--color-ink-faint)]">
                Compose helper
              </p>
              <h2 className="font-[var(--font-display)] text-lg text-[var(--color-ink)]">
                Tag Library
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Tag Library"
              className="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)]"
            >
              <span aria-hidden className="text-xl leading-none">×</span>
            </button>
          </div>
          <div className="mt-3">
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.currentTarget.value)}
              placeholder="Filter tags (try: prison, school, amenity=cafe)"
              className={[
                "w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)]",
                "px-3 py-1.5 text-sm text-[var(--color-ink)]",
                "placeholder:text-[var(--color-ink-faint)]",
                "focus:border-[var(--color-accent)] focus:outline-none",
              ].join(" ")}
            />
            <p className="mt-1 text-[10px] text-[var(--color-ink-faint)]">
              Filters the bundled OSM tag index live (21k tags, offline).
              Curated entries above stay visible.
            </p>
          </div>
        </header>

        {/* Three-column body */}
        <div
          className="grid min-h-0 flex-1 overflow-hidden"
          style={{ gridTemplateColumns: "200px 220px 1fr" }}
        >
          <div className="min-h-0 border-r border-[var(--color-line)] bg-[var(--color-surface-sunken)]">
            <TagLibraryBrowse
              selectedCuratedId={selection.curated?.id ?? null}
              onSelectCurated={onSelectCurated}
            />
          </div>
          <div className="min-h-0 border-r border-[var(--color-line)] bg-[var(--color-surface-raised)]">
            <TagLibraryValues
              filterQuery={searchInput}
              selectedKey={selection.key}
              selectedValue={selection.value}
              onSelectTag={(key, value) =>
                setSelection({ key, value, curated: null })
              }
            />
          </div>
          <div className="min-h-0 bg-[var(--color-surface)]">{detailContent}</div>
        </div>

        {/* Consent modal — overlays the drawer body when pending. */}
        {consentPending && (
          <ConsentModal
            onAllow={() => resolveConsent(true)}
            onDeny={() => resolveConsent(false)}
          />
        )}
      </aside>
    </>
  );
}

interface DetailEmptyProps {
  headline: string;
  body: string;
}

function DetailEmpty({ headline, body }: DetailEmptyProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <h3 className="font-[var(--font-display)] text-base text-[var(--color-ink-soft)]">
        {headline}
      </h3>
      <p className="mt-2 max-w-xs text-xs text-[var(--color-ink-faint)]">{body}</p>
    </div>
  );
}

interface ConsentModalProps {
  onAllow: () => void;
  onDeny: () => void;
}

/**
 * First-Taginfo-call-per-session confirmation. Mirrors the existing
 * enrichment-confirmation pattern (the Overpass and Nominatim opt-ins) so
 * investigators always know when a network call is about to fire.
 */
function ConsentModal({ onAllow, onDeny }: ConsentModalProps) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="taginfo-consent-title"
      className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-ink)]/40 px-4"
    >
      <div className="max-w-md rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-5 shadow-2xl">
        <h3
          id="taginfo-consent-title"
          className="font-[var(--font-display)] text-base text-[var(--color-ink)]"
        >
          About to query Taginfo
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-soft)]">
          The Tag Library fetches usage counts and wiki summaries from{" "}
          <code className="font-[var(--font-mono)] text-xs">
            taginfo.openstreetmap.org
          </code>
          . That server can see your queries. Responses are cached locally for 7 days.
        </p>
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
          The curated glossary on the left works offline either way.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onDeny}>
            Stay offline
          </Button>
          <Button variant="primary" onClick={onAllow}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
