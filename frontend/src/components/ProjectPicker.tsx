import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FieldShell, TextInput } from "@/components/ui/Field";
import { useProjectStore } from "@/stores/project";
import { TitleBarCompass } from "./TitleBarCompass";

export function ProjectPicker() {
  const projects = useProjectStore((s) => s.projects);
  const loading = useProjectStore((s) => s.loadingProjects);
  const createProject = useProjectStore((s) => s.createProject);
  const openProject = useProjectStore((s) => s.openProject);
  const setMode = useProjectStore((s) => s.setMode);

  const [newName, setNewName] = useState("");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-8 py-12">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
          <TitleBarCompass size={14} />
          <span>Overpass Styler</span>
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

      {/* Top-of-page paired entry cards: Create project (existing) sits to the
          left, Browse the map sits to the right. Both are equally-weighted so
          the picker reads as "two ways to start", not "one and an aside". */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-5 shadow-sm">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h2 className="font-[var(--font-display)] text-lg text-[var(--color-ink)]">
              New project
            </h2>
            <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
              Field notebook
            </span>
          </div>
          <p className="mb-4 text-xs leading-relaxed text-[var(--color-ink-soft)]">
            Compose Overpass queries, style each category, and export a single styled
            KML for Google Earth Pro.
          </p>
          <FieldShell label="Project name">
            <div className="flex gap-2">
              <TextInput
                placeholder="e.g. Mariupol — Mar 2026"
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
        </div>

        {/* Browse entry — sibling card. Click-anywhere flips the store mode and
            App.tsx routes to BrowseMode. */}
        <button
          type="button"
          onClick={() => setMode("browse")}
          className="group relative flex flex-col rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-5 text-left shadow-sm transition-colors hover:border-[color:var(--accent-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-ink)]"
        >
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h2 className="font-[var(--font-display)] text-lg text-[var(--color-ink)]">
              Browse the map
            </h2>
            <span
              className="text-[10px] uppercase tracking-[0.18em]"
              style={{ color: "var(--accent-ink)" }}
            >
              Field atlas
            </span>
          </div>
          <p className="mb-4 flex-1 text-xs leading-relaxed text-[var(--color-ink-soft)]">
            See what OpenStreetMap knows about an area before you decide what to query
            for. Drill into amenities, buildings, landuse, and military features —
            then bake a slice into a new or existing project.
          </p>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[color:var(--accent-ink)]">
            Open the atlas
            <span
              aria-hidden
              className="transition-transform group-hover:translate-x-0.5"
            >
              →
            </span>
          </span>
        </button>
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
