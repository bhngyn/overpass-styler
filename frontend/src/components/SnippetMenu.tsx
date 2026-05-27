/**
 * SnippetMenu — dropdown listing starter Overpass QL snippets.
 *
 * Click a snippet to insert it into the query editor. Parent owns the
 * cursor position and the actual textarea, so this component is pure.
 */
import { QUERY_SNIPPETS, type Snippet } from "@/lib/querySnippets";

interface Props {
  onInsert: (snippet: Snippet) => void;
  onClose: () => void;
}

export function SnippetMenu({ onInsert, onClose }: Props) {
  return (
    <div
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
