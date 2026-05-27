/**
 * QueryEditor — the right-rail form for composing a single Overpass query.
 *
 * Owns the textarea, snippet/tag-library trigger buttons, run/results/add-as-layer
 * actions, and the first-call-per-session confirmation modal. Pure with respect
 * to drafts: parent passes a draft + onChange + onRun + onAddAsLayer.
 */
import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FieldShell, TextInput } from "@/components/ui/Field";
import { BboxPicker, type Bbox } from "@/components/BboxPicker";
import { SnippetMenu } from "@/components/SnippetMenu";
import type { Snippet } from "@/lib/querySnippets";

export interface QueryDraftRunResult {
  totalCount: number;
  topTags: { key: string; value: string; count: number }[];
}

export interface QueryDraft {
  id: string;
  name: string;
  query: string;
  bbox: Bbox | null;
  regionLabel: string | null;
  lastRunResult: QueryDraftRunResult | null;
}

export interface QueryEditorProps {
  draft: QueryDraft;
  onChange: (next: QueryDraft) => void;
  onRun: () => Promise<void>;
  onAddAsLayer: () => Promise<void>;
  running: boolean;
  adding?: boolean;
  /** Seam for B3 — clicking "Tag Library" opens the drawer; we just signal up. */
  onOpenTagLibrary?: () => void;
  /** Module-level flag the parent owns: has the user already confirmed Overpass calls this session? */
  overpassConfirmed: boolean;
  onConfirmOverpass: () => void;
}

export function QueryEditor({
  draft,
  onChange,
  onRun,
  onAddAsLayer,
  running,
  adding = false,
  onOpenTagLibrary,
  overpassConfirmed,
  onConfirmOverpass,
}: QueryEditorProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function insertAtCursor(text: string) {
    const ta = taRef.current;
    if (!ta) {
      onChange({ ...draft, query: draft.query + text });
      return;
    }
    const start = ta.selectionStart ?? draft.query.length;
    const end = ta.selectionEnd ?? draft.query.length;
    const before = draft.query.slice(0, start);
    const after = draft.query.slice(end);
    const next = before + text + after;
    onChange({ ...draft, query: next });
    // Restore cursor *after* the inserted text on the next tick.
    requestAnimationFrame(() => {
      ta.focus();
      const pos = before.length + text.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  function handleSnippet(s: Snippet) {
    // For a fresh-feeling draft (empty or whitespace), replace whole body.
    // Otherwise splice in at the cursor — investigators sometimes paste
    // multiple snippets together.
    if (draft.query.trim().length === 0) {
      onChange({ ...draft, query: s.ql });
    } else {
      insertAtCursor("\n" + s.ql + "\n");
    }
  }

  async function attemptRun() {
    if (!overpassConfirmed) {
      setConfirmOpen(true);
      return;
    }
    await onRun();
  }

  return (
    <div className="space-y-4">
      <Eyebrow>Query</Eyebrow>

      <FieldShell label="Layer name">
        <TextInput
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="e.g. Detention sites — Mariupol Mar 2026"
        />
      </FieldShell>

      <FieldShell label="Region">
        <BboxPicker
          bbox={draft.bbox}
          regionLabel={draft.regionLabel}
          onChange={({ bbox, regionLabel }) => onChange({ ...draft, bbox, regionLabel })}
        />
      </FieldShell>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span
            className="uppercase text-[var(--color-ink-faint)]"
            style={{ fontSize: "10px", letterSpacing: "0.18em", fontWeight: 600 }}
          >
            Overpass QL
          </span>
          <div className="relative flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSnippetsOpen((v) => !v)}
              aria-expanded={snippetsOpen}
              aria-haspopup="menu"
            >
              Snippets {snippetsOpen ? "▴" : "▾"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenTagLibrary?.()}
              disabled={!onOpenTagLibrary}
              title={onOpenTagLibrary ? "Open the Tag Library" : "Tag Library coming soon"}
            >
              Tag Library
            </Button>
            {snippetsOpen && (
              <div className="relative">
                <SnippetMenu
                  onInsert={handleSnippet}
                  onClose={() => setSnippetsOpen(false)}
                />
              </div>
            )}
          </div>
        </div>
        <textarea
          ref={taRef}
          value={draft.query}
          onChange={(e) => onChange({ ...draft, query: e.target.value })}
          spellCheck={false}
          rows={14}
          placeholder="[out:json][timeout:25];&#10;nwr[&quot;amenity&quot;=&quot;prison&quot;]({{bbox}});&#10;out body geom;"
          className="block w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2.5 py-2 font-[var(--font-mono)] text-[12px] leading-relaxed text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none"
          style={{ tabSize: 2 }}
        />
        <p className="mt-1 text-[10px] text-[var(--color-ink-faint)]">
          Use <code className="font-[var(--font-mono)]">{"{{bbox}}"}</code> as a
          placeholder — the selected region gets substituted at run time.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          onClick={() => void attemptRun()}
          disabled={running || draft.query.trim().length === 0}
        >
          {running ? "Running…" : "Run query"}
        </Button>
        {running && (
          <span className="text-[11px] text-[var(--color-ink-faint)]">
            Calling overpass-api.de…
          </span>
        )}
      </div>

      {draft.lastRunResult && (
        <ResultsCard result={draft.lastRunResult} />
      )}

      {draft.lastRunResult && (
        <Button
          variant="primary"
          onClick={() => void onAddAsLayer()}
          disabled={adding}
          className="w-full justify-center"
        >
          {adding ? "Baking…" : "Add as layer"}
        </Button>
      )}

      {confirmOpen && (
        <ConfirmOverpassModal
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async () => {
            onConfirmOverpass();
            setConfirmOpen(false);
            await onRun();
          }}
        />
      )}
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="uppercase text-[var(--color-ink-faint)]"
      style={{ fontSize: "10px", letterSpacing: "0.22em", fontWeight: 600 }}
    >
      {children}
    </p>
  );
}

function ResultsCard({ result }: { result: QueryDraftRunResult }) {
  return (
    <div
      className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-3"
      title="These tags would become categories when you add this layer."
    >
      <div className="flex items-baseline justify-between">
        <span
          className="uppercase text-[var(--color-ink-faint)]"
          style={{ fontSize: "10px", letterSpacing: "0.22em", fontWeight: 600 }}
        >
          Result
        </span>
        <span className="font-[var(--font-display)] text-lg text-[var(--color-ink)]">
          {result.totalCount.toLocaleString()}
          <span className="ml-1 text-[11px] font-normal text-[var(--color-ink-faint)]">
            features
          </span>
        </span>
      </div>
      {result.topTags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {result.topTags.map((t, i) => (
            <span
              key={i}
              className="rounded-full border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-soft)]"
            >
              {t.key}={t.value} <span className="text-[var(--color-ink-faint)]">×{t.count}</span>
            </span>
          ))}
        </div>
      )}
      <p className="mt-2 text-[10px] italic text-[var(--color-ink-faint)]">
        These tags would become categories when you add this layer.
      </p>
    </div>
  );
}

function ConfirmOverpassModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="overpass-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(26,23,20,0.4)] p-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-5 shadow-xl"
      >
        <h2
          id="overpass-confirm-title"
          className="font-[var(--font-display)] text-lg text-[var(--color-ink)]"
        >
          Reach out to Overpass?
        </h2>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          Running this query reaches out to <code className="font-[var(--font-mono)]">overpass-api.de</code>.
          Anything you query is visible to that server. We won't ask again this session.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Run query
          </Button>
        </div>
      </div>
    </div>
  );
}
