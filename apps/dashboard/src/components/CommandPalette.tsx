import {
  BookOpen,
  Files,
  Keyboard,
  MagnifyingGlass,
  Monitor,
  MoonStars,
  Plus,
  ShieldCheck,
  SquaresFour,
  Sun,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { keys, useMe } from "../lib/queries.js";
import { useTheme } from "../lib/theme.js";
import { useExitTransition } from "../lib/use-exit-transition.js";
import { openShortcuts } from "./Shortcuts.js";

/**
 * Case-insensitive subsequence match: every character of `query` appears in
 * `text` in order (not necessarily contiguous). Empty query matches everything.
 * Local, dependency-free — the palette's filter is small (a handful of commands +
 * the owner's canvases), so a real fuzzy library would be overkill.
 */
export function fuzzyMatch(text: string, query: string): boolean {
  if (query === "") return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return i === q.length;
}

interface Command {
  id: string;
  /** The label shown in the list and matched against the query. */
  label: string;
  /** Extra searchable text (kept out of the visible label). */
  keywords?: string;
  hint?: string;
  icon: ComponentType<{
    size?: number;
    weight?: "regular" | "bold" | "fill";
    "aria-hidden"?: boolean;
  }>;
  run: () => void;
}

/**
 * Command palette (⌘K / Ctrl-K). A keyboard-first overlay for navigation and a
 * few quick actions. Mounted once app-wide in the shell; owns its own open/close
 * keyboard shortcut. Reuses the Dialog focus-trap conventions (focus moves in on
 * open, Tab is trapped, Escape closes, focus restored on close) and the
 * `cd-anim-*` enter/exit motion via `useExitTransition`.
 *
 * a11y: a combobox/listbox pattern — the input owns `role=combobox` with
 * `aria-controls` pointing at the `role=listbox`; each result is a `role=option`
 * with `aria-selected` on the highlighted row.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const me = useMe();
  const { setChoice } = useTheme();
  // Owner canvases for "Jump to a canvas…". Loaded lazily — only fetched while the
  // palette is open (`enabled` keeps the query inert in this mount otherwise). Reuses
  // the shared list query key so it dedupes with the library's own fetch.
  const canvases = useQuery({
    queryKey: keys.canvasesList({}),
    queryFn: () => api.listCanvases({}),
    enabled: open,
  });

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const labelId = useId();
  const { mounted, state } = useExitTransition(open);

  const close = () => setOpen(false);

  // Global ⌘K / Ctrl-K toggles the palette. Lives at the shell so it works from
  // any route. We intentionally don't gate on focus target — the palette is a
  // global affordance and ⌘K isn't a browser/editor default we'd clobber.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Reset the query + highlight each time the palette opens, and move focus into
  // the input. Restore focus to the opener on close (mirrors the Dialog trap).
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setActive(0);
    // Focus after the panel mounts.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  const themeCommands: Command[] = useMemo(
    () => [
      {
        id: "theme-light",
        label: "Switch to light theme",
        keywords: "theme appearance light",
        icon: Sun,
        run: () => setChoice("light"),
      },
      {
        id: "theme-dark",
        label: "Switch to dark theme",
        keywords: "theme appearance dark",
        icon: MoonStars,
        run: () => setChoice("dark"),
      },
      {
        id: "theme-system",
        label: "Use system theme",
        keywords: "theme appearance system auto",
        icon: Monitor,
        run: () => setChoice("system"),
      },
    ],
    [setChoice],
  );

  const navCommands: Command[] = useMemo(() => {
    const list: Command[] = [
      {
        id: "nav-canvases",
        label: "Go to Canvases",
        keywords: "home library your canvases",
        icon: Files,
        run: () => void navigate({ to: "/" }),
      },
      {
        id: "nav-gallery",
        label: "Go to Gallery",
        keywords: "browse explore gallery",
        icon: SquaresFour,
        run: () => void navigate({ to: "/gallery" }),
      },
    ];
    if (me.data?.isAdmin) {
      list.push({
        id: "nav-admin",
        label: "Go to Admin",
        keywords: "admin settings users",
        icon: ShieldCheck,
        run: () => void navigate({ to: "/admin" }),
      });
    }
    list.push({
      id: "nav-docs",
      label: "Open Docs",
      keywords: "documentation help docs",
      icon: BookOpen,
      // Docs are server-rendered outside the SPA — a real navigation, not a Link.
      run: () => {
        window.location.href = "/docs";
      },
    });
    list.push({
      id: "create-canvas",
      label: "Create canvas",
      keywords: "new add canvas",
      icon: Plus,
      run: () => void navigate({ to: "/new" }),
    });
    list.push({
      id: "shortcuts",
      label: "Keyboard shortcuts",
      keywords: "shortcuts keyboard cheatsheet help",
      icon: Keyboard,
      run: () => openShortcuts(),
    });
    return list;
  }, [navigate, me.data?.isAdmin]);

  // "Jump to a canvas…" — only contributes results once the query is non-empty,
  // so an empty palette stays a short command list rather than the whole library.
  const canvasCommands: Command[] = useMemo(() => {
    if (query.trim() === "") return [];
    const rows = canvases.data?.canvases ?? [];
    return rows.map((c) => ({
      id: `canvas-${c.id}`,
      label: c.title,
      keywords: `${c.slug} canvas jump open`,
      hint: "Canvas",
      icon: Files,
      run: () => void navigate({ to: "/canvases/$id", params: { id: c.id } }),
    }));
  }, [query, canvases.data, navigate]);

  const allCommands = useMemo(
    () => [...navCommands, ...themeCommands, ...canvasCommands],
    [navCommands, themeCommands, canvasCommands],
  );

  const results = useMemo(
    () =>
      allCommands.filter(
        (c) => fuzzyMatch(c.label, query.trim()) || fuzzyMatch(c.keywords ?? "", query.trim()),
      ),
    [allCommands, query],
  );

  // Keep the highlight in bounds as the filtered list shrinks/grows.
  useEffect(() => {
    setActive((a) => (results.length === 0 ? 0 : Math.min(a, results.length - 1)));
  }, [results.length]);

  // Keep the active row visible: the "Jump to a canvas…" results can exceed the
  // height-capped listbox, so arrow-key movement past the visible window must
  // scroll the highlighted option into view. Optional-chained for jsdom (which
  // doesn't implement scrollIntoView), mirroring TabNav.
  const resultCount = results.length;
  useEffect(() => {
    if (resultCount === 0) return;
    // Index into the rendered options (they mirror `results` order) — avoids
    // escaping the composite useId()-derived option id in a selector.
    const el = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[active];
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, resultCount]);

  const runAt = (index: number) => {
    const cmd = results[index];
    if (!cmd) return;
    cmd.run();
    close();
  };

  function onPanelKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length === 0 ? 0 : (a + 1) % results.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (results.length === 0 ? 0 : (a - 1 + results.length) % results.length));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
      return;
    }
    if (e.key === "Tab") {
      // The input is the only tabbable control; keep focus from escaping the panel.
      e.preventDefault();
    }
  }

  if (!mounted) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; keyboard users dismiss via Escape
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="cd-anim-scrim absolute inset-0 bg-[var(--scrim)] backdrop-blur-[2px]"
        data-state={state}
        aria-hidden
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard handled on the input/listbox combobox below */}
      <div
        ref={panelRef}
        data-state={state}
        onKeyDown={onPanelKeyDown}
        className="cd-anim-pop relative flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface-raised shadow-[var(--shadow-popover)]"
      >
        <span id={labelId} className="sr-only">
          Command palette
        </span>
        <div className="flex items-center gap-2.5 border-border border-b px-4">
          <MagnifyingGlass size={18} weight="bold" aria-hidden className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-labelledby={labelId}
            aria-activedescendant={results[active] ? `${listId}-${results[active].id}` : undefined}
            placeholder="Search commands or jump to a canvas…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="h-12 w-full bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
          />
        </div>
        <ul
          ref={listRef}
          id={listId}
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the combobox/listbox pattern requires a listbox role on the options container
          role="listbox"
          aria-labelledby={labelId}
          className="max-h-[min(60vh,22rem)] overflow-y-auto p-1.5"
        >
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-muted text-sm" role="presentation">
              No matching commands
            </li>
          ) : (
            results.map((cmd, i) => (
              <CommandRow
                key={cmd.id}
                id={`${listId}-${cmd.id}`}
                cmd={cmd}
                selected={i === active}
                onPointerEnter={() => setActive(i)}
                onClick={() => runAt(i)}
              />
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

function CommandRow({
  id,
  cmd,
  selected,
  onPointerEnter,
  onClick,
}: {
  id: string;
  cmd: Command;
  selected: boolean;
  onPointerEnter: () => void;
  onClick: () => void;
}): ReactNode {
  const Icon = cmd.icon;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation is handled by the combobox (Enter on the input); the click is a pointer affordance
    // biome-ignore lint/a11y/useFocusableInteractive: the combobox input owns focus; the active option is tracked via aria-activedescendant
    <li
      id={id}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: combobox/listbox pattern — each result is a listbox option
      role="option"
      aria-selected={selected}
      onPointerEnter={onPointerEnter}
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm",
        selected ? "bg-accent-subtle text-fg" : "text-muted",
      )}
    >
      <Icon size={16} weight="bold" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-fg">{cmd.label}</span>
      {cmd.hint && <span className="shrink-0 text-subtle text-xs">{cmd.hint}</span>}
    </li>
  );
}
