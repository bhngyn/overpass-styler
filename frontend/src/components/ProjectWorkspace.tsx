import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { THEMES, themeById } from "@/lib/palettes";
import { useProjectStore } from "@/stores/project";
import { ProjectTree } from "./ProjectTree";
import { MapPreview } from "./MapPreview";
import { ContextPanel } from "./ContextPanel";

export function ProjectWorkspace() {
  const proj = useProjectStore((s) => s.currentProject);
  const sourceFiles = useProjectStore((s) => s.sourceFiles);
  const close = useProjectStore((s) => s.closeProject);
  const rename = useProjectStore((s) => s.renameProject);
  const deleteProject = useProjectStore((s) => s.deleteCurrentProject);
  const importKml = useProjectStore((s) => s.importKml);
  const busy = useProjectStore((s) => s.busy);
  const themeId = useProjectStore((s) => s.themeId);
  const applyTheme = useProjectStore((s) => s.applyTheme);
  const setAllVisible = useProjectStore((s) => s.setAllVisible);
  const hiddenCategoriesCount = useProjectStore(
    (s) => s.hiddenCategories.size + s.hiddenSourceFiles.size,
  );
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Distinct category keys across the project's files. Prefer the freshly
  // detailed value (covers legacy rows where the summary is still null) and
  // fall back to the summary so we don't flicker before details load.
  const distinctCategoryKeys = (() => {
    if (!proj) return [] as string[];
    const seen: string[] = [];
    for (const sf of proj.source_files) {
      const key = sourceFiles[sf.id]?.category_key ?? sf.category_key;
      if (key && !seen.includes(key)) seen.push(key);
    }
    return seen;
  })();

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(proj?.name ?? "");

  useEffect(() => {
    setDraftName(proj?.name ?? "");
  }, [proj?.name]);

  if (!proj) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-ink-faint)]">
        Loading project…
      </div>
    );
  }

  const onExport = () => {
    window.location.href = api.exportUrl(proj.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Title bar */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--color-line)] bg-[var(--color-surface-raised)] px-4 py-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={close}
            className="text-xs uppercase tracking-wider text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
          >
            ← All projects
          </button>
          <span className="text-[var(--color-line)]">·</span>
          {editingName ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.currentTarget.value)}
              onBlur={async () => {
                if (draftName.trim() && draftName !== proj.name) await rename(draftName.trim());
                setEditingName(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setDraftName(proj.name);
                  setEditingName(false);
                }
              }}
              className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-sm"
            />
          ) : (
            <h1
              onClick={() => setEditingName(true)}
              className="cursor-text font-[var(--font-display)] text-base text-[var(--color-ink)]"
              title="Click to rename"
            >
              {proj.name}
            </h1>
          )}
          {distinctCategoryKeys.length > 0 && (
            <span className="text-xs text-[var(--color-ink-faint)]">
              grouped by{" "}
              {distinctCategoryKeys.map((key, i) => (
                <span key={key}>
                  {i > 0 && <span className="mx-1">·</span>}
                  <code className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-soft)]">
                    {key}
                  </code>
                </span>
              ))}
            </span>
          )}
          {busy && <span className="text-xs text-[var(--color-ink-faint)]">working…</span>}
        </div>

        <div className="flex items-center gap-2">
          {/* Theme picker — applies a palette to all current categories. */}
          <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1">
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
              theme
            </span>
            <select
              value={themeId}
              onChange={(e) => applyTheme(e.currentTarget.value)}
              title={themeById(themeId).description}
              className="bg-transparent text-xs text-[var(--color-ink)] focus:outline-none"
            >
              {THEMES.map((t) => (
                <option key={t.id} value={t.id} title={t.description}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {hiddenCategoriesCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setAllVisible(true)}>
              Show all ({hiddenCategoriesCount} hidden)
            </Button>
          )}

          <input
            ref={fileInput}
            type="file"
            accept=".kml,application/vnd.google-earth.kml+xml,application/xml,text/xml"
            multiple
            hidden
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              for (const f of files) await importKml(f);
              if (fileInput.current) fileInput.current.value = "";
            }}
          />
          <Button onClick={() => fileInput.current?.click()}>Import KML…</Button>
          <Button variant="primary" onClick={onExport} disabled={proj.source_files.length === 0}>
            Export styled KML
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (confirm(`Delete project "${proj.name}"? This cannot be undone.`)) {
                deleteProject();
              }
            }}
          >
            Delete project
          </Button>
        </div>
      </header>

      {/* Three-pane layout.
          The row template is explicit (minmax(0,1fr)) so the row fills the grid's
          height rather than collapsing to fit-content. Without this the middle
          <main> would size to its absolute child (height 0) and the map would
          render invisibly. */}
      <div
        className="grid min-h-0 flex-1 grid-cols-[280px_1fr_400px] overflow-hidden"
        style={{ gridTemplateRows: "minmax(0, 1fr)" }}
      >
        <aside className="min-h-0 overflow-y-auto border-r border-[var(--color-line)] bg-[var(--color-surface-sunken)]">
          <ProjectTree />
        </aside>
        <main className="relative min-h-0 min-w-0 overflow-hidden bg-[#eae6dc]">
          <MapPreview />
        </main>
        <aside className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-surface-raised)]">
          <ContextPanel />
        </aside>
      </div>
    </div>
  );
}
