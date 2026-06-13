import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

/** Pick a CodeMirror language extension from a file path's extension (R17). */
function languageFor(path: string): Extension[] {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "html":
    case "htm":
      return [html()];
    case "css":
      return [css()];
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return [javascript({ jsx: true })];
    case "ts":
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    case "json":
      return [json()];
    case "md":
    case "markdown":
      return [markdown()];
    default:
      return [];
  }
}

const baseExtensions: Extension[] = [
  lineNumbers(),
  foldGutter(),
  highlightActiveLineGutter(),
  history(),
  drawSelection(),
  indentOnInput(),
  bracketMatching(),
  highlightActiveLine(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  EditorView.lineWrapping,
  EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "var(--surface)",
      color: "var(--fg)",
      fontSize: "13px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      lineHeight: "1.62",
    },
    ".cm-content": { padding: "12px 0", caretColor: "var(--accent)" },
    ".cm-line": { padding: "0 16px" },
    ".cm-gutters": {
      backgroundColor: "var(--canvas)",
      color: "var(--subtle)",
      borderRight: "1px solid var(--border)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "3.25rem",
      padding: "0 12px 0 10px",
    },
    ".cm-foldGutter .cm-gutterElement": { padding: "0 6px" },
    ".cm-activeLine": { backgroundColor: "var(--accent-subtle)" },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--accent-subtle)",
      color: "var(--accent)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "var(--accent-subtle)",
      color: "var(--fg)",
      outline: "1px solid var(--border-strong)",
    },
  }),
];

export interface CodeEditorProps {
  /** Stable identity for the open document — remounts the view when it changes. */
  path: string;
  value: string;
  readOnly?: boolean;
  onChange: (next: string) => void;
}

/**
 * CodeMirror 6 editor over a single draft file (R17). The view is created once per
 * `path`; `value` seeds the initial document (the parent owns the source of truth
 * and re-keys this component per file, so we don't reconcile external value changes
 * into a live view — that avoids cursor-jump on autosave round-trips).
 */
export function CodeEditor({ path, value, readOnly = false, onChange }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Re-create the view only when the open file or readOnly changes — `value` is an
  // initial doc seed, not a live binding (the parent re-keys per file), so it's
  // intentionally excluded from the deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value seeds the initial doc by design
  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        ...baseExtensions,
        ...languageFor(path),
        EditorState.readOnly.of(readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    return () => view.destroy();
  }, [path, readOnly]);

  return (
    <div
      ref={host}
      data-testid="code-editor"
      className="h-full overflow-hidden rounded-xl border border-border bg-surface shadow-sm shadow-black/5"
    />
  );
}
