import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

interface FieldShellProps {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  inline?: boolean;
}

export function FieldShell({ label, hint, children, inline = false }: FieldShellProps) {
  return (
    <label
      className={[
        "block",
        inline ? "flex items-center justify-between gap-3" : "space-y-1",
      ].join(" ")}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
        {label}
      </span>
      {children}
      {hint && <span className="text-xs text-[var(--color-ink-faint)]">{hint}</span>}
    </label>
  );
}

export function TextInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={[
        "w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)]",
        "px-2.5 py-1.5 text-sm text-[var(--color-ink)]",
        "placeholder:text-[var(--color-ink-faint)]",
        "focus:border-[var(--color-accent)] focus:outline-none",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

export function TextArea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={[
        "w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)]",
        "px-2.5 py-1.5 text-sm text-[var(--color-ink)]",
        "focus:border-[var(--color-accent)] focus:outline-none",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

export function Select({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLSelectElement> & { children?: ReactNode }) {
  return (
    <select
      className={[
        "w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface-raised)]",
        "px-2.5 py-1.5 text-sm text-[var(--color-ink)]",
        "focus:border-[var(--color-accent)] focus:outline-none",
        className,
      ].join(" ")}
      {...(rest as object)}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
}) {
  const pill = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
        checked
          ? "bg-[var(--color-accent)] border-[var(--color-accent)]"
          : "bg-[var(--color-surface-sunken)] border-[var(--color-line)]",
      ].join(" ")}
    >
      <span
        className={[
          "block h-4 w-4 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        ].join(" ")}
      />
    </button>
  );

  if (!label) return pill;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {pill}
      <span className="text-xs text-[var(--color-ink-soft)]">{label}</span>
    </span>
  );
}
