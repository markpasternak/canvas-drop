/**
 * IDE-style editor footer — part of the opt-in structural chrome (see base.css). It's
 * always rendered but `.cd-statusbar` keeps it hidden, so CSS reveals it only under the
 * skins whose design language wants it (`workshop`, `canvas`). No skin branching in JS:
 * the same markup ships for every skin and the cascade decides whether it shows.
 */
export function EditorStatusBar({ path, fileCount }: { path: string | null; fileCount: number }) {
  return (
    <div className="cd-statusbar items-center gap-3 rounded-b-xl border border-t-0 border-border bg-accent px-3 py-1 font-mono text-[0.6875rem] text-accent-fg">
      <span className="min-w-0 truncate">{path ?? "no file selected"}</span>
      <span className="opacity-80">UTF-8</span>
      <span className="opacity-80">LF</span>
      <span className="flex-1" />
      <span className="opacity-90">canvas-drop</span>
      <span className="opacity-80 tabular-nums">
        {fileCount} {fileCount === 1 ? "file" : "files"}
      </span>
    </div>
  );
}
