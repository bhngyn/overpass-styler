/**
 * BakeHandoffModal — confirms the bake from BrowseMode into a project layer.
 *
 * Three handoff flavours feed in via the `prefill` prop:
 *
 * 1. "find-more"   — same-tag query, bbox = current viewport. Spawned by
 *                    FeatureDetail's "Find more like this" button.
 * 2. "area-by-tag" — same tag, whole bbox. Spawned by FeatureDetail's
 *                    "Save area to project as layer" button.
 * 3. "single"      — one-feature mode, ingests just the selected feature.
 *
 * The UI lets the user pick a destination project (existing dropdown +
 * "Create new project…") and edit the layer name. On submit it calls the
 * store action `bakeFromBrowse`, which routes through the backend's
 * /api/browse/bake endpoint, auto-opens the result, and flips back into
 * project mode.
 *
 * After a successful bake we display a tiny in-modal confirmation card
 * rather than a separate toast — the store has already navigated the user
 * into the new project, so the modal close button doubles as "got it".
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FieldShell, Select, TextInput } from "@/components/ui/Field";
import { useProjectStore } from "@/stores/project";
import type { BakeHandoffPrefill } from "./FeatureDetail";

interface Props {
  prefill: BakeHandoffPrefill;
  open: boolean;
  onClose: () => void;
}

type ProjectChoice = number | "new";

export function BakeHandoffModal({ prefill, open, onClose }: Props) {
  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const bakeFromBrowse = useProjectStore((s) => s.bakeFromBrowse);

  // Default destination: the currently-open project if any, otherwise "new".
  // The store keeps the project list fresh via refreshProjects() during
  // mount; if it's empty, "new" is the only sensible choice.
  const initialChoice: ProjectChoice =
    currentProjectId ?? (projects[0]?.id ?? "new");
  const [choice, setChoice] = useState<ProjectChoice>(initialChoice);
  const [newProjectName, setNewProjectName] = useState("");
  const [layerName, setLayerName] = useState(prefill.defaultName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Reset local state every time the modal opens with a new prefill.
  useEffect(() => {
    if (!open) return;
    setChoice(initialChoice);
    setLayerName(prefill.defaultName);
    setNewProjectName("");
    setSubmitting(false);
    setError(null);
    setDone(false);
    // initialChoice intentionally excluded — it's computed from currentProjectId
    // which is stable within an open() lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill]);

  if (!open) return null;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const project_id = choice === "new" ? null : choice;
      const name = layerName.trim() || prefill.defaultName;
      const body =
        prefill.mode === "single"
          ? {
              project_id,
              name: choice === "new" ? newProjectName.trim() || name : name,
              single_osm_id: prefill.single_osm_id,
            }
          : {
              project_id,
              name: choice === "new" ? newProjectName.trim() || name : name,
              bbox: prefill.bbox,
              query: prefill.query,
            };
      await bakeFromBrowse(body);
      setDone(true);
      // The store has already opened the destination project + flipped
      // mode to "project". The modal will be unmounted when BrowseMode
      // re-renders; this only matters in the brief window before that.
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const modeLabel =
    prefill.mode === "single"
      ? "Save single feature"
      : prefill.mode === "find-more"
        ? "Find more like this"
        : "Save area as layer";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bake-modal-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-raised)] shadow-lg">
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
              Bake to project
            </div>
            <h2
              id="bake-modal-title"
              className="font-[var(--font-display)] text-base text-[var(--color-ink)]"
            >
              {modeLabel}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] disabled:opacity-60"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {done ? (
          <div className="px-4 py-5">
            <div className="rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-3 py-2 text-sm text-[var(--color-accent)]">
              Layer baked. Switching to the project workspace…
            </div>
            <div className="mt-3 flex justify-end">
              <Button variant="primary" onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 px-4 py-3">
            <FieldShell label="Destination project">
              <Select
                value={String(choice)}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  setChoice(v === "new" ? "new" : Number(v));
                }}
              >
                {projects.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
                <option value="new">+ Create new project…</option>
              </Select>
            </FieldShell>

            {choice === "new" && (
              <FieldShell label="New project name">
                <TextInput
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.currentTarget.value)}
                  placeholder="e.g. Mariupol — Reconnaissance"
                />
              </FieldShell>
            )}

            <FieldShell label="Layer name">
              <TextInput
                value={layerName}
                onChange={(e) => setLayerName(e.currentTarget.value)}
                placeholder={prefill.defaultName}
              />
            </FieldShell>

            {/* Query preview — only meaningful in non-single modes. The user
                can't edit it here (Compose owns query editing); this is a
                read-only confirmation of what's about to run. */}
            {prefill.mode !== "single" && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">
                  Overpass QL
                </div>
                <pre className="mt-0.5 max-h-32 overflow-y-auto rounded-md border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-2 font-[var(--font-mono)] text-[10px] leading-relaxed text-[var(--color-ink-soft)]">
                  {prefill.query}
                </pre>
                <div className="mt-1 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
                  bbox: {prefill.bbox.map((n) => n.toFixed(3)).join(", ")}
                </div>
              </div>
            )}

            {prefill.mode === "single" && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">
                  OSM id
                </div>
                <code className="mt-0.5 block rounded-md border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-2 font-[var(--font-mono)] text-[11px] text-[var(--color-ink-soft)]">
                  {prefill.single_osm_id}
                </code>
              </div>
            )}

            {error && (
              <div className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-[var(--color-line)] pt-3">
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={submit}
                disabled={
                  submitting ||
                  (choice === "new" && !newProjectName.trim() && !layerName.trim())
                }
              >
                {submitting ? "Baking…" : "Bake"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
