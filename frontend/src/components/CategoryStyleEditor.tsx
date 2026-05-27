import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FieldShell, TextInput, Toggle } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { defaultFeatureStyle } from "@/lib/defaults";
import type { FeatureStyle, PresetSummary } from "@/lib/types";
import { useProjectStore } from "@/stores/project";
import { ColorOpacityPicker } from "./ColorOpacityPicker";
import { IconPicker } from "./IconPicker";

interface Props {
  sourceFileId: number;
  categoryValue: string;
}

export function CategoryStyleEditor({ sourceFileId, categoryValue }: Props) {
  const proj = useProjectStore((s) => s.currentProject);
  const detail = useProjectStore((s) => s.sourceFiles[sourceFileId]);
  const saveStyle = useProjectStore((s) => s.saveCategoryStyle);
  const categoryKey = detail?.category_key ?? proj?.category_key;

  const stored = proj?.category_styles?.[categoryValue];
  const [style, setStyle] = useState<FeatureStyle>(stored ?? defaultFeatureStyle());
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");

  // Whenever the user switches category, reset local style from store.
  useEffect(() => {
    setStyle(stored ?? defaultFeatureStyle());
  }, [categoryValue, stored]);

  // Debounced save to backend.
  useEffect(() => {
    const t = window.setTimeout(() => {
      saveStyle(categoryValue, style);
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, categoryValue]);

  useEffect(() => {
    api.listPresets().then(setPresets).catch(() => {});
  }, []);

  const count = detail?.category_counts?.[categoryValue] ?? 0;
  const exampleNames = useMemo(
    () =>
      detail?.placemarks
        ?.filter((p) => p.category_value === categoryValue)
        .map((p) => p.name)
        .filter((n): n is string => Boolean(n))
        .slice(0, 3) ?? [],
    [detail, categoryValue],
  );

  return (
    <div className="space-y-5 p-5">
      <header className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          Category style
        </div>
        <h2 className="font-[var(--font-display)] text-base text-[var(--color-ink)]">
          <code className="font-[var(--font-mono)] text-sm">
            {categoryKey}={categoryValue}
          </code>
        </h2>
        <p className="text-xs text-[var(--color-ink-faint)]">
          {count} placemark{count === 1 ? "" : "s"} affected
          {exampleNames.length > 0 && (
            <>
              {" "}· e.g. <span className="italic">{exampleNames.join(", ")}</span>
            </>
          )}
        </p>
      </header>

      {/* Polygon section */}
      <SectionCard
        title="Polygon"
        controls={
          <>
            <Toggle
              checked={style.polygon.fill}
              onChange={(fill) =>
                setStyle((s) => ({ ...s, polygon: { ...s.polygon, fill } }))
              }
              label="fill"
            />
            <Toggle
              checked={style.polygon.outline}
              onChange={(outline) =>
                setStyle((s) => ({ ...s, polygon: { ...s.polygon, outline } }))
              }
              label="outline"
            />
          </>
        }
      >
        <ColorOpacityPicker
          label="Fill colour & opacity"
          value={style.polygon.fill_color}
          onChange={(fill_color) =>
            setStyle((s) => ({ ...s, polygon: { ...s.polygon, fill_color } }))
          }
        />
        <ColorOpacityPicker
          label="Outline colour"
          value={style.polygon.outline_color}
          onChange={(outline_color) =>
            setStyle((s) => ({ ...s, polygon: { ...s.polygon, outline_color } }))
          }
          showOpacity={false}
        />
        <FieldShell label="Outline width" inline>
          <NumberInput
            value={style.polygon.outline_width}
            min={0}
            step={0.25}
            unit="px"
            onChange={(v) =>
              setStyle((s) => ({
                ...s,
                polygon: { ...s.polygon, outline_width: v },
              }))
            }
          />
        </FieldShell>
      </SectionCard>

      {/* Point / icon section */}
      <SectionCard title="Point icon">
        <IconPicker
          value={style.icon.icon_href}
          onChange={(icon_href) =>
            setStyle((s) => ({ ...s, icon: { ...s.icon, icon_href } }))
          }
        />
        <ColorOpacityPicker
          label="Icon tint"
          value={style.icon.color}
          onChange={(color) => setStyle((s) => ({ ...s, icon: { ...s.icon, color } }))}
        />
        <FieldShell label="Scale" inline>
          <NumberInput
            value={style.icon.scale}
            min={0.25}
            max={3}
            step={0.05}
            unit="×"
            onChange={(v) =>
              setStyle((s) => ({ ...s, icon: { ...s.icon, scale: v } }))
            }
          />
        </FieldShell>
      </SectionCard>

      {/* Label section */}
      <SectionCard
        title="Label"
        controls={
          <Toggle
            checked={style.label.show}
            onChange={(show) => setStyle((s) => ({ ...s, label: { ...s.label, show } }))}
            label="show"
          />
        }
      >
        <ColorOpacityPicker
          label="Label colour"
          value={style.label.color}
          onChange={(color) => setStyle((s) => ({ ...s, label: { ...s.label, color } }))}
          showOpacity={false}
        />
        <FieldShell label="Scale" inline>
          <NumberInput
            value={style.label.scale}
            min={0.25}
            max={3}
            step={0.05}
            unit="×"
            onChange={(v) =>
              setStyle((s) => ({ ...s, label: { ...s.label, scale: v } }))
            }
          />
        </FieldShell>
      </SectionCard>

      {/* Presets */}
      <SectionCard title="Presets" dense>
        <div className="flex flex-wrap gap-1">
          {presets.length === 0 && (
            <span className="text-xs text-[var(--color-ink-faint)]">
              No saved presets yet.
            </span>
          )}
          {presets.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => setStyle(p.style)}
              className="rounded border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs hover:border-[var(--color-line-strong)]"
            >
              {p.name}
            </button>
          ))}
        </div>
        {savingPreset ? (
          <div className="flex gap-2">
            <TextInput
              autoFocus
              placeholder="Preset name"
              value={presetName}
              onChange={(e) => setPresetName(e.currentTarget.value)}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!presetName.trim()}
              onClick={async () => {
                const created = await api.createPreset(presetName.trim(), style);
                setPresets((ps) => [...ps, created]);
                setPresetName("");
                setSavingPreset(false);
              }}
            >
              Save
            </Button>
            <Button size="sm" onClick={() => setSavingPreset(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={() => setSavingPreset(true)}>
            Save current as preset…
          </Button>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * One styled card in the right pane. The header is a two-row layout so any
 * number of toggles can sit on a controls row beneath the title without
 * competing for horizontal space with the title.
 */
function SectionCard({
  title,
  controls,
  children,
  dense = false,
}: {
  title: string;
  controls?: React.ReactNode;
  children: React.ReactNode;
  dense?: boolean;
}) {
  return (
    <section className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface)]">
      <div
        className={[
          "flex items-center justify-between gap-2 border-b border-[var(--color-line)] px-3 py-2",
          controls ? "min-h-9" : "",
        ].join(" ")}
      >
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
          {title}
        </h3>
        {controls && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{controls}</div>
        )}
      </div>
      <div className={dense ? "space-y-2 p-3" : "space-y-3 p-3"}>{children}</div>
    </section>
  );
}

/** Right-aligned number input with a small trailing unit chip. */
function NumberInput({
  value,
  onChange,
  unit,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="inline-flex items-stretch overflow-hidden rounded border border-[var(--color-line)] bg-[var(--color-surface-raised)]">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-16 bg-transparent px-2 py-1 text-right text-xs focus:outline-none"
      />
      {unit && (
        <span className="flex items-center bg-[var(--color-surface-sunken)] px-1.5 text-[10px] text-[var(--color-ink-faint)]">
          {unit}
        </span>
      )}
    </div>
  );
}
