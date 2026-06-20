import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
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

/**
 * Brand-tokenized syntax highlighting (R17 polish). Maps Lezer highlight tags to the
 * `--syn-*` design tokens (tokens.css), so code colours come from the design system and
 * adapt to light/dark — and to the active skin's surface — with no JS recompute. Replaces
 * CodeMirror's `defaultHighlightStyle`, whose fixed palette was outside the token system.
 */
export const cdHighlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword],
    color: "var(--syn-keyword)",
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue], color: "var(--syn-string)" },
  {
    tag: [t.lineComment, t.blockComment, t.comment, t.docComment, t.meta],
    color: "var(--syn-comment)",
    fontStyle: "italic",
  },
  { tag: [t.number, t.integer, t.float, t.bool, t.atom], color: "var(--syn-num)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName],
    color: "var(--syn-fn)",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-fn)" },
  { tag: [t.tagName], color: "var(--syn-tag)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--syn-attr)" },
  {
    tag: [
      t.punctuation,
      t.separator,
      t.bracket,
      t.angleBracket,
      t.squareBracket,
      t.paren,
      t.brace,
      t.derefOperator,
      t.operator,
      t.compareOperator,
      t.arithmeticOperator,
      t.logicOperator,
    ],
    color: "var(--syn-punc)",
  },
  { tag: [t.heading], color: "var(--syn-fn)", fontWeight: "600" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--syn-keyword)", textDecoration: "underline" },
  { tag: [t.invalid], color: "var(--danger)" },
]);

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
  syntaxHighlighting(cdHighlightStyle, { fallback: true }),
  EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "var(--surface)",
      color: "var(--fg)",
      fontSize: "12.5px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      lineHeight: "1.64",
      scrollbarWidth: "thin",
      scrollbarColor: "var(--border-strong) transparent",
    },
    ".cm-content": { padding: "14px 0 18px", caretColor: "var(--accent)" },
    ".cm-line": { padding: "0 18px" },
    ".cm-gutters": {
      backgroundColor: "var(--surface-sunken)",
      color: "var(--subtle)",
      borderRight: "1px solid var(--border)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "3.25rem",
      padding: "0 12px 0 10px",
    },
    ".cm-foldGutter .cm-gutterElement": { padding: "0 6px" },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--accent-subtle) 58%, transparent)",
    },
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
  /** ⌘S / Ctrl+S — flush the autosave immediately instead of the browser save dialog. */
  onSave?: () => void;
}

/**
 * CodeMirror 6 editor over a single draft file (R17). The view is created once per
 * `path`; `value` seeds the initial document (the parent owns the source of truth
 * and re-keys this component per file, so we don't reconcile external value changes
 * into a live view — that avoids cursor-jump on autosave round-trips).
 */
export function CodeEditor({ path, value, readOnly = false, onChange, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Re-create the view only when the open file or readOnly changes — `value` is an
  // initial doc seed, not a live binding (the parent re-keys per file), so it's
  // intentionally excluded from the deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value seeds the initial doc by design
  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        // ⌘S / Ctrl+S flushes the draft (returning true preempts the browser's "Save
        // page" dialog). Sits before baseExtensions so it wins over the default keymap.
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
        ]),
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

  return <div ref={host} data-testid="code-editor" className="h-full overflow-hidden bg-surface" />;
}
