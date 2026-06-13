import { Button } from "./Button.js";

export interface DraftPreviewProps {
  canvasId: string;
  /** Bumped by the parent to force a reload (e.g. after a save). */
  refreshKey: number;
  onRefresh: () => void;
}

/**
 * Owner-only draft preview (R13) in an iframe pointed at the dashboard-origin
 * preview route (U7). `refreshKey` is part of the src so a save reloads it; the
 * server sends `no-store` so the iframe always shows current draft bytes.
 */
export function DraftPreview({ canvasId, refreshKey, onRefresh }: DraftPreviewProps) {
  const src = `/api/canvases/${canvasId}/preview/?r=${refreshKey}`;
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-subtle">Preview (draft)</span>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      <iframe
        key={refreshKey}
        title="Draft preview"
        src={src}
        className="h-full w-full rounded-md border border-border bg-white"
        sandbox="allow-scripts allow-forms allow-same-origin"
      />
    </div>
  );
}
