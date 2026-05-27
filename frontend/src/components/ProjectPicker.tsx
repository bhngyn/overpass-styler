import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FieldShell, TextInput } from "@/components/ui/Field";
import { useProjectStore } from "@/stores/project";

export function ProjectPicker() {
  const projects = useProjectStore((s) => s.projects);
  const loading = useProjectStore((s) => s.loadingProjects);
  const createProject = useProjectStore((s) => s.createProject);
  const openProject = useProjectStore((s) => s.openProject);

  const [newName, setNewName] = useState("");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-8 py-12">
      <header className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
          Overpass Styler
        </div>
        <h1 className="font-[var(--font-display)] text-3xl tracking-tight text-[var(--color-ink)]">
          Stage your Overpass exports for Google Earth Pro.
        </h1>
        <p className="max-w-xl text-sm leading-relaxed text-[var(--color-ink-soft)]">
          Drop in one or more KML files from Overpass Turbo. Group features by their OSM
          tags, choose colours, opacity, outlines and icons per category, and export a
          styled KML the moment you're ready.
        </p>
      </header>

      <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-5 shadow-sm">
        <FieldShell label="New project">
          <div className="flex gap-2">
            <TextInput
              placeholder="e.g. Chad — Detention sites · May 2026"
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && newName.trim()) {
                  const id = await createProject(newName.trim());
                  setNewName("");
                  await openProject(id);
                }
              }}
            />
            <Button
              variant="primary"
              disabled={!newName.trim()}
              onClick={async () => {
                const id = await createProject(newName.trim());
                setNewName("");
                await openProject(id);
              }}
            >
              Create
            </Button>
          </div>
        </FieldShell>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--color-ink-faint)]">
          Recent projects {loading && <span className="ml-2 normal-case">· loading…</span>}
        </h2>
        {projects.length === 0 && !loading ? (
          <p className="text-sm text-[var(--color-ink-faint)]">
            No projects yet. Create one above to get started.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-raised)]">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => openProject(p.id)}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[var(--color-surface-sunken)]"
                >
                  <div>
                    <div className="text-sm font-medium text-[var(--color-ink)]">{p.name}</div>
                    <div className="text-xs text-[var(--color-ink-faint)]">
                      {p.source_file_count} file{p.source_file_count === 1 ? "" : "s"}
                      {p.category_key && (
                        <>
                          {" "}
                          · grouped by{" "}
                          <code className="font-[var(--font-mono)] text-[11px]">
                            {p.category_key}
                          </code>
                        </>
                      )}
                    </div>
                  </div>
                  <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">
                    {new Date(p.updated_at).toLocaleDateString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
