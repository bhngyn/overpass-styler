/**
 * Stepper — the four-node workflow rail rendered above the workspace.
 *
 * Pure presentational. Steps are freely clickable; the parent decides whether
 * to gate progression (we don't). The line between nodes "inks in" as the
 * user advances — the gradient swaps the dotted-ink pattern for a solid
 * accent stroke at the appropriate stop.
 */

export type WorkflowStep = "compose" | "style" | "review" | "export";

export interface StepperProps {
  current: WorkflowStep;
  onChange: (step: WorkflowStep) => void;
}

interface StepDef {
  id: WorkflowStep;
  label: string;
  index: number; // 1-based for the numbered circle
}

const STEPS: StepDef[] = [
  { id: "compose", label: "Compose", index: 1 },
  { id: "style", label: "Style", index: 2 },
  { id: "review", label: "Review", index: 3 },
  { id: "export", label: "Export", index: 4 },
];

function stepOrdinal(step: WorkflowStep): number {
  return STEPS.findIndex((s) => s.id === step);
}

export function Stepper({ current, onChange }: StepperProps) {
  const currentIdx = stepOrdinal(current);
  // Inked-in fraction: 0 at compose, 1/3 at style, 2/3 at review, 1 at export.
  const inkPct = currentIdx === 0 ? 0 : (currentIdx / (STEPS.length - 1)) * 100;

  return (
    <nav
      aria-label="Workflow"
      className="relative flex items-start justify-between gap-2 px-6 py-3"
    >
      {/* Connector rail — sits behind the nodes. The gradient swaps from
          accent (inked) to a faint dotted pattern (not yet inked) at the
          current step's fraction. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 right-0 top-[22px] z-0 mx-[12%] h-px"
        style={{
          background: `linear-gradient(to right,
            var(--color-accent) 0%,
            var(--color-accent) ${inkPct}%,
            transparent ${inkPct}%,
            transparent 100%)`,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 right-0 top-[22px] z-0 mx-[12%] h-px"
        style={{
          background: `linear-gradient(to right,
            transparent 0%,
            transparent ${inkPct}%,
            var(--color-line-strong) ${inkPct}%,
            var(--color-line-strong) 100%)`,
          // dotted via a tight repeating-linear-gradient mask
          maskImage:
            "repeating-linear-gradient(to right, black 0 3px, transparent 3px 7px)",
          WebkitMaskImage:
            "repeating-linear-gradient(to right, black 0 3px, transparent 3px 7px)",
        }}
      />

      {STEPS.map((step) => {
        const idx = step.index - 1;
        const isActive = step.id === current;
        const isCompleted = idx < currentIdx;
        const isFuture = idx > currentIdx;

        const circleClasses = [
          "relative z-10 flex shrink-0 items-center justify-center rounded-full border transition-all",
          isActive &&
            "h-11 w-11 border-[var(--color-accent)] bg-[var(--color-accent)] text-white shadow-[0_2px_6px_-2px_rgba(177,74,26,0.5)]",
          isCompleted &&
            "h-9 w-9 border-[var(--color-accent)] bg-[var(--color-surface-raised)] text-[var(--color-accent)]",
          isFuture &&
            "h-9 w-9 border-[var(--color-line-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-faint)]",
        ]
          .filter(Boolean)
          .join(" ");

        const labelClasses = [
          "mt-2 select-none text-center transition-colors",
          // small-caps eyebrow styling per design language
          "uppercase",
          isActive
            ? "text-[var(--color-ink)]"
            : isCompleted
              ? "text-[var(--color-ink-soft)]"
              : "text-[var(--color-ink-faint)]",
        ].join(" ");

        return (
          <button
            key={step.id}
            type="button"
            onClick={() => onChange(step.id)}
            aria-current={isActive ? "step" : undefined}
            aria-label={`Step ${step.index}: ${step.label}`}
            className="group relative z-10 flex flex-col items-center focus:outline-none"
          >
            <span className={circleClasses}>
              <span
                className="font-[var(--font-display)] text-base leading-none"
                style={{ fontVariantNumeric: "lining-nums" }}
              >
                {step.index}
              </span>
            </span>
            <span
              className={labelClasses}
              style={{
                fontSize: "10px",
                letterSpacing: "0.2em",
                fontWeight: isActive ? 600 : 500,
              }}
            >
              {step.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
