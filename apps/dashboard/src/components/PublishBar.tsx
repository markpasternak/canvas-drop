import { Badge } from "./Badge.js";
import { Button } from "./Button.js";

export interface PublishBarProps {
  dirty: boolean;
  stale: boolean;
  saving: boolean;
  publishing: boolean;
  canPublish: boolean;
  onPublish: () => void;
}

/**
 * Editor status bar (R18): unpublished-changes indicator, the stale notice (a
 * newer version was published under this draft), live save state, and Publish.
 */
export function PublishBar({
  dirty,
  stale,
  saving,
  publishing,
  canPublish,
  onPublish,
}: PublishBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {stale && (
          <span title="An agent or upload published a newer version under your draft.">
            <Badge tone="warning">A newer version was published</Badge>
          </span>
        )}
        {saving ? (
          <span className="text-xs text-subtle">Saving…</span>
        ) : dirty ? (
          <span className="text-xs text-muted">Unpublished changes</span>
        ) : (
          <span className="text-xs text-subtle">All changes published</span>
        )}
      </div>
      <Button
        size="sm"
        onClick={onPublish}
        loading={publishing}
        disabled={!canPublish}
        title={canPublish ? "Publish the draft as a new live version" : "Nothing to publish"}
      >
        Publish
      </Button>
    </div>
  );
}
