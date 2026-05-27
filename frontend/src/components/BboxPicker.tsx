/**
 * BboxPicker — region selector with three input modes (Search / Draw / Coords).
 *
 * - Search: hits Nominatim directly (no backend proxy in this stream).
 * - Draw: stubbed for v1; another stream will wire MapLibre's draw control.
 * - Coords: four small number inputs (W, S, E, N).
 *
 * The bbox tuple is `[west, south, east, north]` to match the backend API.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";

export type Bbox = [number, number, number, number]; // [W, S, E, N]

interface Props {
  bbox: Bbox | null;
  regionLabel: string | null;
  onChange: (next: { bbox: Bbox | null; regionLabel: string | null }) => void;
}

type Mode = "search" | "draw" | "coords";

interface NominatimHit {
  display_name: string;
  // Nominatim returns [south, north, west, east] as STRINGS.
  boundingbox: [string, string, string, string];
}

export function BboxPicker({ bbox, regionLabel, onChange }: Props) {
  const [mode, setMode] = useState<Mode>("search");

  return (
    <div className="space-y-2">
      <SegmentedControl mode={mode} onChange={setMode} />
      {mode === "search" && (
        <SearchMode
          onPick={(hit) => {
            const south = parseFloat(hit.boundingbox[0]);
            const north = parseFloat(hit.boundingbox[1]);
            const west = parseFloat(hit.boundingbox[2]);
            const east = parseFloat(hit.boundingbox[3]);
            onChange({
              bbox: [west, south, east, north],
              regionLabel: hit.display_name,
            });
          }}
        />
      )}
      {mode === "draw" && <DrawModeStub />}
      {mode === "coords" && (
        <CoordsMode
          bbox={bbox}
          onChange={(next) => onChange({ bbox: next, regionLabel })}
        />
      )}

      <BboxReadout bbox={bbox} regionLabel={regionLabel} />
    </div>
  );
}

function SegmentedControl({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  const tabs: { id: Mode; label: string }[] = [
    { id: "search", label: "Search" },
    { id: "draw", label: "Draw" },
    { id: "coords", label: "Coords" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Region input mode"
      className="inline-flex rounded-md border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-0.5"
    >
      {tabs.map((t) => {
        const active = t.id === mode;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(t.id)}
            className={[
              "rounded px-2.5 py-1 text-[11px]",
              active
                ? "bg-[var(--color-surface-raised)] text-[var(--color-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-soft)]",
            ].join(" ")}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function SearchMode({ onPick }: { onPick: (hit: NominatimHit) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<NominatimHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`;
      const resp = await fetch(url, {
        // Nominatim asks all clients to identify themselves.
        headers: { "Accept-Language": "en", "User-Agent": "overpass-styler/1.0" },
      });
      if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
      const data = (await resp.json()) as NominatimHit[];
      setHits(data);
    } catch (e) {
      setError(String(e));
      setHits([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <TextInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Mariupol"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
        />
        <Button onClick={() => void search()} disabled={loading || !q.trim()} size="sm">
          {loading ? "…" : "Search"}
        </Button>
      </div>
      {error && (
        <p className="text-[11px] text-[var(--color-danger)]">{error}</p>
      )}
      {hits.length > 0 && (
        <ul className="max-h-44 space-y-0 overflow-y-auto rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)]">
          {hits.map((h, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => {
                  onPick(h);
                  setHits([]);
                }}
                className="block w-full truncate px-2.5 py-1.5 text-left text-[11px] hover:bg-[var(--color-surface-sunken)]"
                title={h.display_name}
              >
                {h.display_name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DrawModeStub() {
  return (
    <div className="space-y-1.5">
      <Button
        disabled
        title="Draw-on-map is coming soon. For now, use Search or Coords."
        size="sm"
      >
        Draw on map
      </Button>
      <p className="text-[11px] italic text-[var(--color-ink-faint)]">
        Coming soon — for now, search a place name or paste coordinates below.
      </p>
    </div>
  );
}

function CoordsMode({
  bbox,
  onChange,
}: {
  bbox: Bbox | null;
  onChange: (next: Bbox | null) => void;
}) {
  const [w, setW] = useState(bbox?.[0]?.toString() ?? "");
  const [s, setS] = useState(bbox?.[1]?.toString() ?? "");
  const [e, setE] = useState(bbox?.[2]?.toString() ?? "");
  const [n, setN] = useState(bbox?.[3]?.toString() ?? "");

  function commit(next: { w?: string; s?: string; e?: string; n?: string }) {
    const W = next.w !== undefined ? next.w : w;
    const S = next.s !== undefined ? next.s : s;
    const E = next.e !== undefined ? next.e : e;
    const N = next.n !== undefined ? next.n : n;
    const nums = [W, S, E, N].map((v) => parseFloat(v));
    if (nums.every((v) => Number.isFinite(v))) {
      onChange([nums[0], nums[1], nums[2], nums[3]]);
    } else {
      onChange(null);
    }
  }

  const inputCls =
    "w-full rounded border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2 py-1 font-[var(--font-mono)] text-[11px] text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none";

  return (
    <div className="grid grid-cols-2 gap-1.5">
      <CoordField label="W" value={w} onChange={(v) => { setW(v); commit({ w: v }); }} cls={inputCls} />
      <CoordField label="S" value={s} onChange={(v) => { setS(v); commit({ s: v }); }} cls={inputCls} />
      <CoordField label="E" value={e} onChange={(v) => { setE(v); commit({ e: v }); }} cls={inputCls} />
      <CoordField label="N" value={n} onChange={(v) => { setN(v); commit({ n: v }); }} cls={inputCls} />
    </div>
  );
}

function CoordField({
  label,
  value,
  onChange,
  cls,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  cls: string;
}) {
  return (
    <label className="block">
      <span
        className="block uppercase text-[var(--color-ink-faint)]"
        style={{ fontSize: "9px", letterSpacing: "0.18em" }}
      >
        {label}
      </span>
      <input
        type="number"
        inputMode="decimal"
        step="any"
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        className={cls}
      />
    </label>
  );
}

function BboxReadout({
  bbox,
  regionLabel,
}: {
  bbox: Bbox | null;
  regionLabel: string | null;
}) {
  if (!bbox) {
    return (
      <p className="text-[11px] italic text-[var(--color-ink-faint)]">
        No region selected — pick a place above to narrow the search.
      </p>
    );
  }
  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5">
      {regionLabel && (
        <p className="truncate text-[11px] text-[var(--color-ink-soft)]" title={regionLabel}>
          {regionLabel}
        </p>
      )}
      <p className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink)]">
        {bbox.map((n) => n.toFixed(4)).join(", ")}
      </p>
      <p
        className="mt-0.5 uppercase text-[var(--color-ink-faint)]"
        style={{ fontSize: "9px", letterSpacing: "0.18em" }}
      >
        W, S, E, N
      </p>
    </div>
  );
}
