import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FieldShell, TextArea, TextInput } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { useProjectStore } from "@/stores/project";

interface Props {
  sourceFileId: number;
  placemarkIndex: number;
}

/** The annotation fields are the same across investigations — keeping this list
 * stable means investigators learn the form once and trust it everywhere.
 *
 * Confidence (Phase B5) uses a 1–4 dot picker — see {@link ConfidenceDots}. */
const ANNOTATION_FIELDS = [
  { key: "note", label: "Note", type: "textarea" as const },
  { key: "source_url", label: "Source URL", type: "url" as const },
  { key: "date_observed", label: "Date observed", type: "date" as const },
  { key: "confidence", label: "Confidence", type: "confidence" as const },
  { key: "field_notes", label: "Field notes", type: "textarea" as const },
];

/** Canonical encoding for the confidence field. Balloon HTML renders the
 * stored string verbatim (`●●●○`), so storage and presentation are the same
 * — what the investigator sees in the inspector is what Earth Pro shows. */
const FILLED = "●"; // ●
const EMPTY = "○"; // ○

/** Render `level` filled dots followed by (4 − level) empty dots. */
function encodeConfidence(level: number): string {
  const lv = Math.max(0, Math.min(4, level));
  return FILLED.repeat(lv) + EMPTY.repeat(4 - lv);
}

/** Read a stored confidence string back into a 0–4 level. Tolerant of legacy
 * "low"/"medium"/"high" values so existing rows don't break. */
function decodeConfidence(raw: string | undefined): number {
  if (!raw) return 0;
  // New encoding: count filled dots.
  if (raw.includes(FILLED) || raw.includes(EMPTY)) {
    return [...raw].filter((c) => c === FILLED).length;
  }
  // Legacy encodings — map the previous select options onto the dot scale.
  const lc = raw.toLowerCase().trim();
  if (lc === "low") return 1;
  if (lc === "medium") return 2;
  if (lc === "high") return 3;
  return 0;
}

export function PlacemarkInspector({ sourceFileId, placemarkIndex }: Props) {
  const proj = useProjectStore((s) => s.currentProject);
  const detail = useProjectStore((s) => s.sourceFiles[sourceFileId]);
  const saveAnnotations = useProjectStore((s) => s.saveAnnotations);
  const refreshSourceFile = useProjectStore((s) => s.refreshSourceFile);
  const setSelection = useProjectStore((s) => s.setSelection);

  const placemark = useMemo(
    () => detail?.placemarks.find((p) => p.index === placemarkIndex) ?? null,
    [detail, placemarkIndex],
  );

  const [fields, setFields] = useState<Record<string, string>>({});
  const [enrichmentBusy, setEnrichmentBusy] = useState<"osm" | "geo" | null>(null);
  const [enrichmentResult, setEnrichmentResult] = useState<string | null>(null);

  useEffect(() => {
    setFields(placemark?.annotations ?? {});
    setEnrichmentResult(null);
  }, [placemark?.index, sourceFileId]);

  if (!proj || !detail || !placemark) {
    return <div className="p-5 text-sm text-[var(--color-ink-faint)]">Loading…</div>;
  }

  const onSaveAnnotations = async () => {
    await saveAnnotations(sourceFileId, placemarkIndex, fields);
  };

  const onRefetchOSM = async () => {
    if (
      !confirm(
        "Re-fetch this placemark's tags from OpenStreetMap?\n\nThis contacts overpass-api.de over the network. The investigator's IP is visible to that server.",
      )
    )
      return;
    setEnrichmentBusy("osm");
    try {
      const result = await api.refetchOsm(proj.id, sourceFileId, placemarkIndex);
      setEnrichmentResult(
        `Overpass returned ${Object.keys(result.tags).length} tag${Object.keys(result.tags).length === 1 ? "" : "s"}. (Note: applying re-fetched tags will be available in a future version.)`,
      );
    } catch (e) {
      setEnrichmentResult(`Overpass call failed: ${String(e)}`);
    } finally {
      setEnrichmentBusy(null);
    }
  };

  const onReverseGeocode = async () => {
    if (
      !confirm(
        "Reverse-geocode this placemark via Nominatim?\n\nThis contacts nominatim.openstreetmap.org over the network. The investigator's IP and the placemark coordinate are visible to that server.",
      )
    )
      return;
    setEnrichmentBusy("geo");
    try {
      const result = await api.reverseGeocode(proj.id, sourceFileId, placemarkIndex);
      const addressFields = Object.entries(result.address).reduce<Record<string, string>>(
        (acc, [k, v]) => {
          acc[`addr_${k}`] = v;
          return acc;
        },
        {},
      );
      setFields((f) => ({
        ...f,
        ...addressFields,
        addr_display: result.display_name,
      }));
      setEnrichmentResult(`Nominatim: ${result.display_name}`);
    } catch (e) {
      setEnrichmentResult(`Nominatim call failed: ${String(e)}`);
    } finally {
      setEnrichmentBusy(null);
    }
  };

  // Back goes to the parent context the placemark lives under:
  //   1. its category (if it has one), or
  //   2. the source file (if there's no category to return to).
  const goBack = () => {
    if (placemark.category_value) {
      setSelection({
        kind: "category",
        sourceFileId,
        categoryValue: placemark.category_value,
      });
    } else {
      setSelection({ kind: "source", sourceFileId });
    }
  };

  const backLabel = placemark.category_value
    ? `${detail.category_key ?? proj.category_key ?? "category"}=${placemark.category_value}`
    : detail.filename;

  return (
    <div className="space-y-5 p-5">
      <button
        type="button"
        onClick={goBack}
        className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)]"
      >
        <span aria-hidden="true">←</span>
        <span className="normal-case tracking-normal text-xs">Back to</span>
        <code className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-soft)]">
          {backLabel}
        </code>
      </button>

      <header className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          Placemark
        </div>
        <h2 className="font-[var(--font-display)] text-base text-[var(--color-ink)]">
          {placemark.name ?? `Placemark #${placemark.index}`}
        </h2>
        {placemark.category_value && (
          <p className="text-xs text-[var(--color-ink-faint)]">
            <code className="font-[var(--font-mono)] text-[11px]">
              {detail.category_key ?? proj.category_key}={placemark.category_value}
            </code>
          </p>
        )}
      </header>

      {/* Annotations */}
      <section className="space-y-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-ink-faint)]">
            Investigator annotations
          </h3>
          <Button size="sm" variant="primary" onClick={onSaveAnnotations}>
            Save
          </Button>
        </div>
        <div className="space-y-3">
          {ANNOTATION_FIELDS.map((f) => (
            <FieldShell key={f.key} label={f.label}>
              {f.type === "textarea" && (
                <TextArea
                  rows={2}
                  value={fields[f.key] ?? ""}
                  onChange={(e) =>
                    setFields((cur) => ({ ...cur, [f.key]: e.currentTarget.value }))
                  }
                />
              )}
              {f.type === "confidence" && (
                <ConfidenceDots
                  value={fields[f.key] ?? ""}
                  onChange={(next) =>
                    setFields((cur) => ({ ...cur, [f.key]: next }))
                  }
                />
              )}
              {(f.type === "url" || f.type === "date") && (
                <TextInput
                  type={f.type}
                  value={fields[f.key] ?? ""}
                  onChange={(e) =>
                    setFields((cur) => ({ ...cur, [f.key]: e.currentTarget.value }))
                  }
                />
              )}
            </FieldShell>
          ))}
        </div>
      </section>

      {/* OSM tag dump */}
      <section className="space-y-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-ink-faint)]">
          Source OSM tags
        </h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          {placemark.extended_data_order.map((key) => (
            <FragmentRow key={key} k={key} v={placemark.extended_data[key]} />
          ))}
        </dl>
      </section>

      {/* Enrichment */}
      <section className="space-y-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-ink-faint)]">
          Enrichment <span className="normal-case text-[var(--color-ink-faint)]">(opt-in, contacts external servers)</span>
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={onRefetchOSM}
            disabled={enrichmentBusy !== null || !placemark.extended_data["@id"]}
          >
            {enrichmentBusy === "osm" ? "Calling Overpass…" : "Re-fetch from OSM"}
          </Button>
          <Button
            size="sm"
            onClick={onReverseGeocode}
            disabled={enrichmentBusy !== null || !placemark.geometry}
          >
            {enrichmentBusy === "geo" ? "Calling Nominatim…" : "Reverse-geocode"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => refreshSourceFile(sourceFileId)}>
            Refresh
          </Button>
        </div>
        {enrichmentResult && (
          <p className="text-xs text-[var(--color-ink-soft)]">{enrichmentResult}</p>
        )}
      </section>
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="truncate font-[var(--font-mono)] text-[11px] text-[var(--color-ink-faint)]">
        {k}
      </dt>
      <dd className="break-all text-[11px] text-[var(--color-ink)]">{v}</dd>
    </>
  );
}

/**
 * ConfidenceDots — 1–4 dot picker.
 *
 * Renders four buttons; clicking dot N sets the value to N filled dots
 * followed by (4 − N) empty dots. Clicking the currently-active dot
 * un-sets the value (level 0 → empty string), so the field can be cleared
 * without a separate clear button.
 *
 * The stored encoding (`●●●○`) is also what Earth Pro renders in the
 * exported balloon — what the investigator sees is what gets published.
 */
function ConfidenceDots({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const level = decodeConfidence(value);
  const labels = ["Unknown", "Single source", "Two sources", "Corroborated", "Verified"];
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Confidence level">
        {[1, 2, 3, 4].map((n) => {
          const filled = n <= level;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={level === n}
              aria-label={`${n} of 4 — ${labels[n]}`}
              onClick={() => onChange(level === n ? "" : encodeConfidence(n))}
              className={[
                "inline-flex h-6 w-6 items-center justify-center rounded text-sm leading-none transition-colors",
                filled
                  ? "text-[color:var(--accent-ink)] hover:text-[var(--color-ink)]"
                  : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-soft)]",
              ].join(" ")}
            >
              <span aria-hidden>{filled ? FILLED : EMPTY}</span>
            </button>
          );
        })}
      </div>
      <span className="text-[11px] text-[var(--color-ink-faint)]">
        {level === 0 ? "—" : labels[level]}
      </span>
    </div>
  );
}
