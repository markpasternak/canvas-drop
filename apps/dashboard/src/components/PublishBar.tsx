import {
  Browser,
  CheckCircle,
  Code,
  Files,
  FloppyDisk,
  TextAa,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";
import { Button } from "./Button.js";

export type EditorSurface = "code" | "onpage";
export type EditorPane = "files" | "code" | "preview" | "onpage";

export interface PublishBarProps {
  dirty: boolean;
  stale: boolean;
  saving: boolean;
  publishing: boolean;
  canPublish: boolean;
  /** Whether the draft has any files — distinguishes "nothing to publish" from "matches live". */
  hasFiles: boolean;
  selectedPath: string | null;
  surface: EditorSurface;
  pane: EditorPane;
  onPaneChange: (pane: EditorPane) => void;
  onCodeMode: () => void;
  onOnPageMode: () => void;
  onPageAvailable: boolean;
  onPageHint: string;
  previewAvailable: boolean;
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
  hasFiles,
  selectedPath,
  surface,
  pane,
  onPaneChange,
  onCodeMode,
  onOnPageMode,
  onPageAvailable,
  onPageHint,
  previewAvailable,
  onPublish,
}: PublishBarProps) {
  const status = saving
    ? { label: "Saving...", tone: "text-subtle", icon: FloppyDisk }
    : dirty
      ? { label: "Unpublished changes", tone: "text-muted", icon: FloppyDisk }
      : stale
        ? { label: "Draft behind live", tone: "text-warning", icon: WarningCircle }
        : { label: "All changes published", tone: "text-subtle", icon: CheckCircle };
  const StatusIcon = status.icon;

  return (
    <div className="sticky top-14 z-20 -mx-2 rounded-xl border border-border bg-surface/95 px-3 py-2 shadow-[var(--shadow-panel)] backdrop-blur supports-[backdrop-filter]:bg-surface/85 md:mx-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {stale && (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-warning/25 bg-warning-subtle px-2 py-1 text-xs font-medium text-warning"
              title="An agent or upload published a newer version under your draft."
            >
              <WarningCircle size={15} weight="fill" aria-hidden />A newer version was published
            </span>
          )}
          <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", status.tone)}>
            <StatusIcon size={15} weight="bold" aria-hidden />
            {status.label}
          </span>
          {selectedPath && (
            <span className="hidden min-w-0 max-w-[24rem] truncate border-l border-border pl-3 font-mono text-xs text-subtle sm:block">
              {selectedPath}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-border bg-surface-sunken p-0.5">
            <ModeButton active={surface === "code"} onClick={onCodeMode}>
              <Code size={15} weight="bold" aria-hidden />
              Code
            </ModeButton>
            <ModeButton
              active={surface === "onpage"}
              onClick={onOnPageMode}
              disabled={!onPageAvailable}
              title={onPageAvailable ? "Edit text directly on the rendered page" : onPageHint}
            >
              <TextAa size={15} weight="bold" aria-hidden />
              Page text
            </ModeButton>
          </div>
          <Button
            size="sm"
            onClick={onPublish}
            loading={publishing}
            disabled={!canPublish}
            title={
              canPublish
                ? "Publish the draft as a new live version"
                : hasFiles
                  ? "The live version already matches this draft"
                  : "Add a file to the draft before publishing"
            }
          >
            Publish draft
          </Button>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1 lg:hidden">
        <PaneButton active={pane === "files"} onClick={() => onPaneChange("files")}>
          <Files size={15} weight="bold" aria-hidden />
          Files
        </PaneButton>
        <PaneButton active={pane === "code"} onClick={() => onPaneChange("code")}>
          <Code size={15} weight="bold" aria-hidden />
          Code
        </PaneButton>
        <PaneButton
          active={pane === "preview"}
          onClick={() => onPaneChange("preview")}
          disabled={!previewAvailable}
        >
          <Browser size={15} weight="bold" aria-hidden />
          Preview
        </PaneButton>
        <PaneButton
          active={pane === "onpage"}
          onClick={() => {
            onOnPageMode();
            onPaneChange("onpage");
          }}
          disabled={!onPageAvailable}
          title={onPageAvailable ? "Edit text directly on the rendered page" : onPageHint}
        >
          <TextAa size={15} weight="bold" aria-hidden />
          Page
        </PaneButton>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors duration-100 [transition-timing-function:var(--ease-out)] disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-surface-raised text-fg shadow-[var(--shadow-panel)]"
          : "text-muted hover:text-fg",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function PaneButton({
  active,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors duration-100 [transition-timing-function:var(--ease-out)] disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-accent-subtle text-accent"
          : "border border-border bg-surface text-muted hover:bg-surface-hover hover:text-fg",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
