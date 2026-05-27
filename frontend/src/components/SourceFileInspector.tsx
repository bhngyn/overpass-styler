import { useProjectStore } from "@/stores/project";

export function SourceFileInspector({ sourceFileId }: { sourceFileId: number }) {
  const detail = useProjectStore((s) => s.sourceFiles[sourceFileId]);
  const setSelection = useProjectStore((s) => s.setSelection);

  if (!detail) {
    return <div className="p-5 text-sm text-[var(--color-ink-faint)]">Loading…</div>;
  }

  const total = detail.placemark_count;
  const categories = Object.entries(detail.category_counts).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-4 p-5">
      <header className="space-y-1">
        <h2 className="font-[var(--font-display)] text-base text-[var(--color-ink)]">
          {detail.filename}
        </h2>
        <p className="text-xs text-[var(--color-ink-faint)]">
          {total} placemark{total === 1 ? "" : "s"} · {categories.length} categor
          {categories.length === 1 ? "y" : "ies"}
        </p>
      </header>

      <section className="space-y-2">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-ink-faint)]">
          Categories
        </h3>
        {categories.length === 0 ? (
          <p className="text-xs text-[var(--color-ink-faint)]">
            No category tag detected. You can change the category key from the project
            title bar.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] rounded-md border border-[var(--color-line)]">
            {categories.map(([value, count]) => (
              <li key={value}>
                <button
                  type="button"
                  onClick={() =>
                    setSelection({
                      kind: "category",
                      sourceFileId,
                      categoryValue: value,
                    })
                  }
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[var(--color-surface-sunken)]"
                >
                  <code className="font-[var(--font-mono)] text-xs">{value}</code>
                  <span className="text-[10px] text-[var(--color-ink-faint)]">{count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
