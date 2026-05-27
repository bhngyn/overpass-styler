/**
 * TitleBarCompass — a tiny inline-SVG compass for the workspace title bar.
 *
 * Pure decoration: a thin steel-blue circle with a 4-point rose. The CSS class
 * `compass-wobble` does a slow ±2deg sway loop (see index.css). `prefers-
 * reduced-motion` disables the animation.
 *
 * Sized for sitting next to a project title — defaults to 16px, but a caller
 * can override via `size` (e.g. the larger picker hero or a future onboarding
 * splash).
 */
interface Props {
  size?: number;
  className?: string;
  /** Disable the wobble — useful in static contexts like screenshots. */
  still?: boolean;
}

export function TitleBarCompass({ size = 16, className = "", still = false }: Props) {
  return (
    <span
      aria-hidden="true"
      className={`${still ? "" : "compass-wobble"} ${className}`.trim()}
      style={{ width: size, height: size, lineHeight: 0 }}
    >
      <svg
        viewBox="0 0 32 32"
        width={size}
        height={size}
        fill="none"
        stroke="var(--accent-ink, currentColor)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="16" cy="16" r="11" />
        {/* Cardinal ticks */}
        <line x1="16" y1="3" x2="16" y2="6" />
        <line x1="16" y1="26" x2="16" y2="29" />
        <line x1="3" y1="16" x2="6" y2="16" />
        <line x1="26" y1="16" x2="29" y2="16" />
        {/* Compass rose — north triangle filled */}
        <path d="M16 7 L19 16 L16 14 L13 16 Z" fill="var(--accent-ink, currentColor)" stroke="none" />
        <path d="M16 25 L19 16 L16 18 L13 16 Z" />
      </svg>
    </span>
  );
}
