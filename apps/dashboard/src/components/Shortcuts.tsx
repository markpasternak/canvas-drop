import { useEffect, useState } from "react";
import { Dialog } from "./Dialog.js";

/** The keyboard shortcuts the dashboard binds, shown in the cheatsheet. */
const SHORTCUTS: ReadonlyArray<{ keys: string[]; label: string }> = [
  { keys: ["⌘", "K"], label: "Open the command palette" },
  { keys: ["⌘", "↵"], label: "Publish the draft (in the editor)" },
  { keys: ["⌘", "S"], label: "Save the draft (in the editor)" },
  { keys: ["?"], label: "Show this shortcuts list" },
];

/** True when the event target is a text-entry surface, so a bare "?" typed into an
 *  input/textarea/contenteditable isn't hijacked as the cheatsheet shortcut. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Custom DOM event other surfaces (user menu, command palette) dispatch to open
 *  the cheatsheet without prop-drilling an opener through the shell. */
export const OPEN_SHORTCUTS_EVENT = "canvas-drop:open-shortcuts";

/** Open the keyboard-shortcuts cheatsheet from anywhere in the app. */
export function openShortcuts() {
  document.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
}

function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-grid min-w-[1.75rem] place-items-center rounded-md border border-border bg-surface-sunken px-1.5 py-1 font-medium font-sans text-[0.8125rem] text-fg shadow-[0_1px_0_hsl(var(--shadow-color)/0.18)]">
      {children}
    </kbd>
  );
}

/**
 * Keyboard shortcut cheatsheet. Opens on a bare "?" (unless focus is in a text
 * field) and is also linkable from the user menu / command palette. `open`/`onClose`
 * are controlled so callers can open it programmatically; the component also owns the
 * "?" global shortcut so it works app-wide once mounted. Reuses the focus-trapped
 * Dialog (Escape closes, focus restored).
 */
export function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Move faster with the keyboard."
    >
      <dl className="divide-y divide-border">
        {SHORTCUTS.map((s) => (
          <div key={s.label} className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-fg text-sm">{s.label}</dt>
            <dd className="flex shrink-0 items-center gap-1">
              {s.keys.map((k) => (
                <Keycap key={k}>{k}</Keycap>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

/**
 * Self-contained cheatsheet wired to the global "?" shortcut. Mounted once in the
 * shell. Owns its open state and the keydown listener so "?" works from any route,
 * while staying inert when the user is typing in a field.
 */
export function ShortcutsHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setOpen(true);
    }
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    document.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    };
  }, []);
  return <Shortcuts open={open} onClose={() => setOpen(false)} />;
}
