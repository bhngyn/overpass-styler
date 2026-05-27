import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { IconCatalogue, IconRecord } from "@/lib/types";

interface Props {
  value: string;
  onChange: (href: string) => void;
}

let _cache: IconCatalogue | null = null;
let _inflight: Promise<IconCatalogue> | null = null;

function fetchIcons(): Promise<IconCatalogue> {
  if (_cache) return Promise.resolve(_cache);
  if (_inflight) return _inflight;
  _inflight = api.icons().then((c) => {
    _cache = c;
    _inflight = null;
    return c;
  });
  return _inflight;
}

// Human-readable tab labels. Keys not in this map fall back to the raw group key.
// Order here is informational only — actual tab order comes from the backend
// catalogue, which puts `atrocity` first.
const GROUP_LABELS: Record<string, string> = {
  atrocity: "Atrocity investigations",
  hr: "Human rights",
  paddle: "Paddles",
  shapes: "Shapes",
  pal2: "Palette 2",
  pal3: "Palette 3",
  pal4: "Palette 4",
  pal5: "Palette 5",
};

// Subgroup labels for the atrocity palette. These are passed through from the
// backend as-is; the map exists to let us localise / rename without touching
// the Python source if we want to.
const ATROCITY_SUBGROUP_LABELS: Record<string, string> = {
  Detention: "Detention",
  Mortality: "Mortality",
  Destruction: "Destruction",
  Military: "Military",
  Displacement: "Displacement",
  Civilian: "Civilian objects",
  Evidence: "Evidence",
};

const FALLBACK_TAB = "atrocity";

// Groups whose icons are white silhouettes on transparent — they need a dark
// backdrop cell to be visible in the picker grid and chip.
const BUNDLED_WHITE_GROUPS = new Set(["atrocity", "hr"]);

function isBundledWhiteHref(href: string): boolean {
  return (
    href.startsWith("/api/icons/atrocity/") || href.startsWith("/api/icons/hr/")
  );
}

function groupBySubgroup(icons: IconRecord[]): Array<{ subgroup: string | null; icons: IconRecord[] }> {
  const blocks: Array<{ subgroup: string | null; icons: IconRecord[] }> = [];
  for (const icon of icons) {
    const sub = icon.subgroup ?? null;
    const last = blocks[blocks.length - 1];
    if (last && last.subgroup === sub) {
      last.icons.push(icon);
    } else {
      blocks.push({ subgroup: sub, icons: [icon] });
    }
  }
  return blocks;
}

function readableHref(href: string): string {
  return href
    .replace("http://maps.google.com/mapfiles/kml/", "")
    .replace("/api/icons/atrocity/", "")
    .replace("/api/icons/hr/", "");
}

function subgroupLabel(activeTab: string, subgroup: string | null): string | null {
  if (!subgroup) return null;
  if (activeTab === "atrocity") {
    return ATROCITY_SUBGROUP_LABELS[subgroup] ?? subgroup;
  }
  return subgroup;
}

export function IconPicker({ value, onChange }: Props) {
  const [cat, setCat] = useState<IconCatalogue | null>(_cache);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>(FALLBACK_TAB);

  useEffect(() => {
    if (!cat) fetchIcons().then(setCat);
  }, [cat]);

  const groups = cat ? Object.keys(cat) : [];
  const activeTab = groups.includes(tab) ? tab : groups[0] ?? FALLBACK_TAB;
  const blocks = useMemo(
    () => (cat ? groupBySubgroup(cat[activeTab] ?? []) : []),
    [cat, activeTab],
  );
  // White-silhouette bundled icons (atrocity + HR) need a dark backdrop to be
  // visible in the selected-icon chip — Google's coloured icons sit better on
  // light.
  const valueIsBundled = isBundledWhiteHref(value);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
          Icon
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-xs text-[var(--color-ink-soft)] underline hover:text-[var(--color-ink)]"
        >
          {open ? "close" : "change"}
        </button>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2 py-1.5">
        <span
          className={[
            "flex h-7 w-7 shrink-0 items-center justify-center rounded",
            valueIsBundled ? "bg-[var(--color-ink)]" : "bg-[var(--color-surface)]",
          ].join(" ")}
        >
          <img src={value} alt="" className="h-5 w-5 object-contain" />
        </span>
        <code className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
          {readableHref(value)}
        </code>
      </div>

      {open && cat && (
        <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-2">
          <div className="mb-2 flex flex-wrap gap-1">
            {groups.map((group) => (
              <button
                type="button"
                key={group}
                onClick={() => setTab(group)}
                className={[
                  "rounded px-2 py-0.5 text-[10px] uppercase tracking-wider",
                  activeTab === group
                    ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                    : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]",
                ].join(" ")}
              >
                {GROUP_LABELS[group] ?? group}
              </button>
            ))}
          </div>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {blocks.map((block, i) => {
              const label = subgroupLabel(activeTab, block.subgroup);
              return (
              <div key={`${block.subgroup ?? "default"}-${i}`}>
                {label && (
                  <div className="mb-1 mt-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-ink-faint)]">
                    {label}
                  </div>
                )}
                <div className="grid grid-cols-8 gap-1">
                  {block.icons.map((icon) => {
                    // Bundled icons (atrocity + HR) are white silhouettes —
                    // they need a dark cell to be visible. Google's stock
                    // icons are coloured raster and read better on a light
                    // cell.
                    const darkCell = BUNDLED_WHITE_GROUPS.has(activeTab);
                    return (
                      <button
                        type="button"
                        key={icon.id}
                        title={icon.label}
                        onClick={() => {
                          onChange(icon.href);
                          setOpen(false);
                        }}
                        className={[
                          "flex h-9 w-9 items-center justify-center rounded border hover:border-[var(--color-accent)]",
                          darkCell
                            ? "bg-[var(--color-ink)]"
                            : "bg-[var(--color-surface)]",
                          value === icon.href
                            ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]"
                            : "border-[var(--color-line)]",
                        ].join(" ")}
                      >
                        <img src={icon.href} alt={icon.label} className="h-6 w-6 object-contain" />
                      </button>
                    );
                  })}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
