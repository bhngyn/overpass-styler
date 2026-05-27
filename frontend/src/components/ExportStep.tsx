// Step 4 — Export. The certificate step.
//
// Left rail   — Document outline: nested tree showing the final KML structure
//               (Document → Folder per source-file → Categories with counts).
//               This is the same skeleton Earth Pro will read in.
//
// Right rail  — Export form: filename input (pre-filled
//               <project-slug>-<YYYY-MM-DD>.kml), two decorative future-toggle
//               switches (Include OSM tags / Include investigator annotations,
//               both default on; backend currently always includes them), and
//               the primary "Generate styled KML" button. After clicking, a
//               success card replaces the form with Earth Pro guidance and a
//               "Start another export cycle" link that resets to Compose.
//
// The component owns only the rails — the centre pane (map) is mounted by the
// parent so MapLibre stays warm across steps.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextInput, Toggle } from "@/components/ui/Field";
import { api } from "@/lib/api";
import type { ProjectDetail, SourceFileDetail } from "@/lib/types";
import { useProjectStore } from "@/stores/project";

/** Container that mounts both rails. Parent slots ExportLeftRail and
 * ExportRightRail into the workspace's grid. */
export function ExportStep() {
  return (
    <>
      <ExportLeftRail />
      <ExportRightRail />
    </>
  );
}

/** Left rail — document outline. */
export function ExportLeftRail() {
  const proj = useProjectStore((s) => s.currentProject);
  const sourceFiles = useProjectStore((s) => s.sourceFiles);
  if (!proj) return null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <Eyebrow>Document outline</Eyebrow>
      <p className="mt-1 mb-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
        Mirrors what Earth Pro will display in its Places sidebar.
      </p>

      <div className="space-y-1 font-[var(--font-mono)] text-[11px]">
        <div className="flex items-center gap-1.5 text-[var(--color-ink)]">
          <FolderIcon />
          <span className="font-medium">{proj.name}</span>
        </div>
        <div className="ml-3 space-y-1.5 border-l border-dotted border-[var(--color-line)] pl-3">
          {proj.source_files.length === 0 ? (
            <div className="text-[11px] italic text-[var(--color-ink-faint)]">
              (empty — no source files to export)
            </div>
          ) : (
            proj.source_files.map((sf) => {
              const detail = sourceFiles[sf.id];
              return (
                <SourceOutline
                  key={sf.id}
                  filename={sf.filename}
                  placemarkCount={sf.placemark_count}
                  detail={detail}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function SourceOutline({
  filename,
  placemarkCount,
  detail,
}: {
  filename: string;
  placemarkCount: number;
  detail: SourceFileDetail | undefined;
}) {
  const categories = detail
    ? Object.entries(detail.category_counts).sort(([a], [b]) => a.localeCompare(b))
    : [];
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-[var(--color-ink-soft)]">
        <FolderIcon />
        <span className="truncate" title={filename}>
          {filename}
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-ink-faint)]">
          {placemarkCount}
        </span>
      </div>
      {categories.length > 0 && (
        <div className="ml-3 space-y-0.5 border-l border-dotted border-[var(--color-line)] pl-3">
          {categories.map(([value, count]) => (
            <div
              key={value}
              className="flex items-center gap-1.5 text-[var(--color-ink-soft)]"
            >
              <TagIcon />
              <span className="truncate">{value}</span>
              <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-ink-faint)]">
                {count}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Right rail — export form + post-export success card. */
export function ExportRightRail() {
  const proj = useProjectStore((s) => s.currentProject);
  const sourceFiles = useProjectStore((s) => s.sourceFiles);
  const setWorkflowStep = useProjectStore((s) => s.setWorkflowStep);

  const defaultFilename = useMemo(() => {
    if (!proj) return "export.kml";
    return `${slugify(proj.name)}-${todayISO()}.kml`;
  }, [proj]);

  const [filename, setFilename] = useState(defaultFilename);
  // Keep the auto-default in sync if the project is renamed while the user is
  // sat on this step *and* hasn't yet edited the filename themselves. Once
  // they've typed in the field we leave their value alone.
  const lastDefault = useRef(defaultFilename);
  useEffect(() => {
    if (filename === lastDefault.current && defaultFilename !== lastDefault.current) {
      setFilename(defaultFilename);
    }
    lastDefault.current = defaultFilename;
  }, [defaultFilename, filename]);

  const [includeOsmTags, setIncludeOsmTags] = useState(true);
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [exportedAt, setExportedAt] = useState<string | null>(null);

  const counts = useMemo(() => computeExportCounts(proj, sourceFiles), [proj, sourceFiles]);

  if (!proj) return null;

  const onGenerate = () => {
    const safe = sanitizeFilename(filename) || defaultFilename;
    // Trigger a download via a transient `<a download>` — keeps the user on the
    // current page (window.location.href would unload React's tree and leave
    // the success card unreachable).
    const a = document.createElement("a");
    a.href = api.exportUrl(proj.id);
    a.download = safe;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setExportedAt(new Date().toISOString());
  };

  if (exportedAt) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
        <Eyebrow>Export complete</Eyebrow>
        <div className="mt-2 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/5 p-4">
          <div className="font-[var(--font-display)] text-base text-[var(--color-ink)]">
            Styled KML downloaded.
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-soft)]">
            Open <span className="font-[var(--font-mono)]">{sanitizeFilename(filename) || defaultFilename}</span>{" "}
            in Google Earth Pro: <span className="text-[var(--color-ink)]">File → Open…</span> and
            pick the file you just saved. Each layer appears as its own folder
            in the Places sidebar; clicking any placemark opens the styled
            balloon you previewed in the Review step.
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
            Earth Pro inlines the icon imagery, so the file is self-contained —
            no network calls required to render it on a colleague's machine.
          </p>
          <div className="mt-4 flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => setExportedAt(null)}
            >
              Export again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setExportedAt(null);
                setWorkflowStep("compose");
              }}
            >
              Start another export cycle
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <section>
        <Eyebrow>Export styled KML</Eyebrow>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          Bakes every category style and investigator annotation into a single
          KML that opens cleanly in Google Earth Pro.
        </p>
      </section>

      <section className="space-y-3 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
        <div className="space-y-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
            Filename
          </label>
          <TextInput
            value={filename}
            onChange={(e) => setFilename(e.currentTarget.value)}
            placeholder={defaultFilename}
          />
        </div>

        <div className="space-y-2">
          {/* Decorative for v1 — the backend always includes both. Surfacing
              them now keeps the toggles in the visual rhythm so when the
              backend gains the knobs there's no UI churn. */}
          <Toggle
            checked={includeOsmTags}
            onChange={setIncludeOsmTags}
            label="Include OSM tags in balloons"
          />
          <Toggle
            checked={includeAnnotations}
            onChange={setIncludeAnnotations}
            label="Include investigator annotations"
          />
        </div>
      </section>

      <section className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-3 text-xs text-[var(--color-ink-soft)]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
            Estimated payload
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-y-1 text-[11px]">
          <span className="text-[var(--color-ink-faint)]">Layers</span>
          <span className="tabular-nums text-right">{counts.layers}</span>
          <span className="text-[var(--color-ink-faint)]">Categories</span>
          <span className="tabular-nums text-right">{counts.categories}</span>
          <span className="text-[var(--color-ink-faint)]">Placemarks</span>
          <span className="tabular-nums text-right">{counts.placemarks}</span>
        </div>
      </section>

      <Button
        variant="primary"
        onClick={onGenerate}
        disabled={proj.source_files.length === 0}
      >
        Generate styled KML
      </Button>
      {proj.source_files.length === 0 && (
        <p className="text-[11px] text-[var(--color-ink-faint)]">
          Add at least one layer in the Compose step before exporting.
        </p>
      )}
    </div>
  );
}

// --- helpers ----------------------------------------------------------------

/** Eyebrow utility — same visual rhythm as ReviewStep. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
      {children}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <circle cx="7" cy="7" r="1.25" />
    </svg>
  );
}

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Lowercase, replace non-word chars with hyphens, collapse runs, trim. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

/** Strip path separators and trailing whitespace; keep dots so .kml survives. */
function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "").trim();
}

function computeExportCounts(
  proj: ProjectDetail | null,
  sourceFiles: Record<number, SourceFileDetail>,
): { layers: number; categories: number; placemarks: number } {
  if (!proj) return { layers: 0, categories: 0, placemarks: 0 };
  let placemarks = 0;
  const categories = new Set<string>();
  for (const sf of proj.source_files) {
    placemarks += sf.placemark_count;
    const d = sourceFiles[sf.id];
    if (d) for (const v of Object.keys(d.category_counts)) categories.add(v);
  }
  return {
    layers: proj.source_files.length,
    categories: categories.size,
    placemarks,
  };
}

