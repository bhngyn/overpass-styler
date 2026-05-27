import { useEffect } from "react";
import { useProjectStore } from "@/stores/project";
import { ProjectPicker } from "@/components/ProjectPicker";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";

export default function App() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const refresh = useProjectStore((s) => s.refreshProjects);
  const error = useProjectStore((s) => s.error);
  const setError = useProjectStore((s) => s.setError);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-danger)]/30 bg-[var(--color-danger)]/8 px-4 py-2 text-sm text-[var(--color-danger)]">
          <span>{error}</span>
          <button type="button" className="text-xs underline" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}
      {currentProjectId == null ? <ProjectPicker /> : <ProjectWorkspace />}
    </div>
  );
}
