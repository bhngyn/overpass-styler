import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-[var(--color-accent)] text-white border-transparent hover:bg-[color-mix(in_oklab,var(--color-accent),black_8%)] disabled:bg-[var(--color-line-strong)]",
  secondary:
    "bg-[var(--color-surface-raised)] text-[var(--color-ink)] border-[var(--color-line)] hover:border-[var(--color-line-strong)]",
  ghost:
    "bg-transparent text-[var(--color-ink-soft)] border-transparent hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)]",
  danger:
    "bg-transparent text-[var(--color-danger)] border-[var(--color-danger)]/40 hover:bg-[var(--color-danger)]/10",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", size = "md", className = "", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={[
        "inline-flex items-center gap-1.5 rounded-md border font-medium",
        "transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-60",
        variantClasses[variant],
        sizeClasses[size],
        className,
      ].join(" ")}
      {...rest}
    />
  );
});
