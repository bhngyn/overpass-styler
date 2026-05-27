import { useId } from "react";
import {
  alphaToOpacity,
  hexRgbToRgba,
  opacityToAlpha,
  rgbaToHexRgb,
  rgbaToKml,
  type RGBA,
} from "@/lib/kmlColor";
import { STARTER_PALETTE } from "@/lib/defaults";

interface Props {
  label: string;
  value: RGBA;
  onChange: (v: RGBA) => void;
  showOpacity?: boolean;
}

export function ColorOpacityPicker({ label, value, onChange, showOpacity = true }: Props) {
  const inputId = useId();
  const hex = rgbaToHexRgb(value);
  const opacity = alphaToOpacity(value.a);

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={inputId}
        className="block text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]"
      >
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="color"
          value={hex}
          onChange={(e) => onChange(hexRgbToRgba(e.currentTarget.value, value.a))}
          className="h-8 w-10 shrink-0 cursor-pointer rounded border border-[var(--color-line)] bg-transparent"
        />
        <input
          type="text"
          value={hex}
          onChange={(e) => {
            try {
              onChange(hexRgbToRgba(e.currentTarget.value, value.a));
            } catch {
              /* ignore mid-typing */
            }
          }}
          className="w-20 shrink-0 rounded border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2 py-1 font-[var(--font-mono)] text-xs"
        />
        <code
          className="shrink-0 whitespace-nowrap rounded bg-[var(--color-surface-sunken)] px-1.5 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]"
          title="KML emits AABBGGRR — alpha first, then BGR"
        >
          {rgbaToKml(value)}
        </code>
      </div>
      <div className="flex flex-wrap gap-1">
        {STARTER_PALETTE.map(([name, h]) => (
          <button
            type="button"
            key={name}
            onClick={() => onChange(hexRgbToRgba(h, value.a))}
            title={name}
            className="h-5 w-5 shrink-0 rounded border border-[var(--color-line)]"
            style={{ backgroundColor: h }}
          />
        ))}
      </div>
      {showOpacity && (
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={opacity}
            onChange={(e) =>
              onChange({ ...value, a: opacityToAlpha(Number(e.currentTarget.value)) })
            }
            className="flex-1 accent-[var(--color-accent)]"
          />
          <span className="w-12 shrink-0 text-right font-[var(--font-mono)] text-[11px] text-[var(--color-ink-soft)]">
            {Math.round(opacity * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}
