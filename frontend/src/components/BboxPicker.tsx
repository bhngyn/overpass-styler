/**
 * BboxPicker — region selector with three input modes (Search / Draw / Coords).
 *
 * The picker is purely a controller: it owns no map. The workspace map
 * (mounted once by ProjectWorkspace as <MapPreview />) is the drawing
 * surface for "Draw" mode, and also visualises the committed bbox for
 * every mode via a persistent overlay. See `lib/workspaceMap.ts` for the
 * shared registry MapPreview registers itself with.
 *
 * - Search: hits Nominatim directly, commits the bbox + flies the
 *   workspace map to it.
 * - Draw: arms drag-to-rectangle on the workspace map.
 * - Coords: four small number inputs (W, S, E, N).
 *
 * The bbox tuple is `[west, south, east, north]` to match the backend API.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import {
  startBboxDraw,
  paintBboxOverlay,
  clearBboxOverlay,
  fitBboxOverlay,
  type BboxDrawHandle,
} from "@/lib/bboxDraw";
import {
  getWorkspaceMap,
  subscribeWorkspaceMap,
  setWorkspaceDrawing,
} from "@/lib/workspaceMap";

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

  // Whenever the bbox prop changes, push the rectangle onto the workspace
  // map as a persistent overlay so the operator can see what they picked
  // — regardless of which input mode produced it. Clears on null.
  useEffect(() => {
    const apply = (map: ReturnType<typeof getWorkspaceMap>) => {
      if (!map) return;
      if (bbox) paintBboxOverlay(map, bbox);
      else clearBboxOverlay(map);
    };
    // Subscribe so we re-apply if the workspace map remounts (e.g.
    // switching workflow steps in and out of Compose).
    return subscribeWorkspaceMap(apply);
  }, [bbox?.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tear down the overlay when the picker unmounts. The bbox is held on
  // the draft, so this clears the visual only; the next mount will repaint.
  useEffect(() => {
    return () => {
      const map = getWorkspaceMap();
      if (map) clearBboxOverlay(map);
    };
  }, []);

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
            const next: Bbox = [west, south, east, north];
            onChange({ bbox: next, regionLabel: hit.display_name });
            const map = getWorkspaceMap();
            if (map) fitBboxOverlay(map, next);
          }}
        />
      )}
      {mode === "draw" && (
        <DrawMode
          onCommit={(next) => onChange({ bbox: next, regionLabel: null })}
          hasBbox={bbox != null}
        />
      )}
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

// ── Draw mode ───────────────────────────────────────────────────────────────
//
// Arms the workspace map for a drag-to-draw interaction. The button is the
// only persistent UI — no inline mini-map. The "Drag · Esc to cancel" hint
// is rendered as a banner overlay above the workspace map by MapPreview's
// existing layout (we just style it in-place here for now via the button
// state). The workspace map captures the actual draw.

function DrawMode({
  onCommit,
  hasBbox,
}: {
  onCommit: (next: Bbox) => void;
  hasBbox: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [mapReady, setMapReady] = useState(() => getWorkspaceMap() != null);
  const drawHandleRef = useRef<BboxDrawHandle | null>(null);

  useEffect(() => {
    // Stay in sync with the workspace map's mount lifecycle so the button
    // disables cleanly if MapPreview hasn't rendered yet (e.g. on the
    // very first visit to Compose before its sibling map has loaded).
    return subscribeWorkspaceMap((m) => {
      setMapReady(m != null);
      if (!m) {
        drawHandleRef.current?.dispose();
        drawHandleRef.current = null;
        setArmed(false);
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      drawHandleRef.current?.dispose();
      drawHandleRef.current = null;
    };
  }, []);

  function startDraw() {
    const map = getWorkspaceMap();
    if (!map) return;
    drawHandleRef.current?.dispose();
    setArmed(true);
    setWorkspaceDrawing(true);
    drawHandleRef.current = startBboxDraw(map, {
      onCommit: (next) => {
        setArmed(false);
        setWorkspaceDrawing(false);
        drawHandleRef.current = null;
        onCommit(next);
        paintBboxOverlay(map, next);
      },
      onCancel: () => {
        setArmed(false);
        setWorkspaceDrawing(false);
        drawHandleRef.current = null;
      },
    });
  }

  function cancelDraw() {
    drawHandleRef.current?.dispose();
    drawHandleRef.current = null;
    setArmed(false);
    setWorkspaceDrawing(false);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {armed ? (
          <Button type="button" size="sm" variant="ghost" onClick={cancelDraw}>
            Cancel
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={startDraw}
            disabled={!mapReady}
            title={
              mapReady
                ? "Click + drag on the map to draw a rectangle"
                : "Waiting for the map to load…"
            }
          >
            {hasBbox ? "Redraw rectangle" : "Draw rectangle"}
          </Button>
        )}
        <p className="text-[11px] italic text-[var(--color-ink-faint)]">
          {!mapReady
            ? "Loading map…"
            : armed
              ? "Click + drag on the map · Esc to cancel."
              : hasBbox
                ? "Pan + zoom the map, then redraw."
                : "Pan + zoom the map to your area, then drag."}
        </p>
      </div>
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
      const out: Bbox = [nums[0], nums[1], nums[2], nums[3]];
      onChange(out);
      const map = getWorkspaceMap();
      if (map) fitBboxOverlay(map, out);
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
