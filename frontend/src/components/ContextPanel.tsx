import { useProjectStore } from "@/stores/project";
import { CategoryStyleEditor } from "./CategoryStyleEditor";
import { PlacemarkInspector } from "./PlacemarkInspector";
import { SourceFileInspector } from "./SourceFileInspector";

export function ContextPanel() {
  const selection = useProjectStore((s) => s.selection);

  if (selection.kind === "none") {
    return (
      <div className="space-y-3 p-5 text-sm text-[var(--color-ink-soft)]">
        <h2 className="font-[var(--font-display)] text-base text-[var(--color-ink)]">
          Get started
        </h2>
        <p>
          Pick a category on the left to style every feature that shares a tag (e.g. every{" "}
          <code className="font-[var(--font-mono)] text-xs">amenity=prison</code>).
        </p>
        <p>
          Pick a single placemark to add notes, source URLs, dates, or to override that
          one feature's style.
        </p>
        <p>
          When you're ready, hit <span className="font-medium">Export styled KML</span>{" "}
          in the top bar.
        </p>
      </div>
    );
  }

  if (selection.kind === "source") {
    return <SourceFileInspector sourceFileId={selection.sourceFileId} />;
  }

  if (selection.kind === "category") {
    return (
      <CategoryStyleEditor
        sourceFileId={selection.sourceFileId}
        categoryValue={selection.categoryValue}
      />
    );
  }

  return (
    <PlacemarkInspector
      sourceFileId={selection.sourceFileId}
      placemarkIndex={selection.placemarkIndex}
    />
  );
}
