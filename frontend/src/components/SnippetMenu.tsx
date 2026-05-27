/**
 * SnippetMenu — dropdown listing starter Overpass QL snippets.
 *
 * Click a snippet to insert it into the query editor. Parent owns the
 * cursor position and the actual textarea, so this component is pure.
 *
 * Closes on Escape and on click outside; the first menuitem receives focus
 * on open so keyboard users can immediately navigate.
 */
import { useEffect, useRef } from "react";
import { QUERY_SNIPPETS, type Snippet } from "@/lib/querySnippets";

interface Props {
  onInsert: (snippet: Snippet) => void;
  onClose: () => void;
}

export function SnippetMenu({ onInsert, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Escape + click-outside dismissal. We listen on `mousedown` rather than
  // `click` so the open-button's own re-click (which would close-then-reopen)
  // still toggles cleanly.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    function onPointer(e: MouseEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      onClose();
    }
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onPointer, true);
    };
  }, [onClose]);

  // Focus the first menuitem on open so arrow / Tab navigation has a starting
  // point and screen readers announce the menu's contents.
  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]',
    );
    first?.focus();
  }, []);

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label="Query snippets"
      className="absolute left-0 top-full z-20 mt-1 w-[22rem] max-w-[90vw] rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] shadow-[0_8px_24px_-8px_rgba(26,23,20,0.25)]"
    >
      <div className="border-b border-[var(--color-line)] px-3 py-2">
        <p
          className="uppercase text-[var(--color-ink-faint)]"
          style={{ fontSize: "10px", letterSpacing: "0.2em" }}
        >
          Insert snippet
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--color-ink-soft)]">
          Starter queries seeded with sensible headers — pick one and tune.
        </p>
      </div>
      <ul className="max-h-80 overflow-y-auto py-1">
        {QUERY_SNIPPETS.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onInsert(s);
                onClose();
              }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-sunken)] focus:bg-[var(--color-surface-sunken)] focus:outline-none"
            >
              <span className="block font-medium text-[var(--color-ink)]">{s.title}</span>
              <span className="mt-0.5 block text-[11px] text-[var(--color-ink-faint)]">
                {s.description}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
