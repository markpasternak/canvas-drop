import { DotsThreeVertical } from "@phosphor-icons/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn.js";

/**
 * The single overflow / "kebab" menu for row- and card-level actions across the
 * dashboard (Your-canvases, gallery, admin tables, versions). Generalizes the
 * one-off menu that used to live inline in the Your-canvases route, adding the
 * WAI-ARIA menu-button keyboard model so every surface behaves identically:
 *
 *   - trigger carries aria-haspopup="menu" + aria-expanded
 *   - opening focuses the first item; ArrowUp/Down roves; Home/End jump
 *   - Escape closes and restores focus to the trigger
 *   - Tab or an outside pointer-down closes
 *
 * The popup is rendered through a portal with fixed positioning so it is never
 * clipped by an ancestor's `overflow:hidden` (gallery cards) or `overflow:auto`
 * (admin tables), and flips above the trigger when there isn't room below.
 *
 * Items are declared as <ActionMenuItem> children (button or anchor). Selecting
 * one runs its handler and closes the menu — the close callback is provided via
 * context so callers never thread it by hand.
 */

interface MenuContext {
  close: () => void;
}

const ActionMenuCtx = createContext<MenuContext | null>(null);

type Align = "start" | "end";

interface Position {
  top: number;
  left?: number;
  right?: number;
}

export function ActionMenu({
  label,
  align = "end",
  children,
  className,
}: {
  label: string;
  align?: Align;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  const computePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const menuH = menuRef.current?.offsetHeight ?? 0;
    // Flip above when there isn't room below but there is above.
    const below = rect.bottom + gap;
    const flipUp = menuH > 0 && below + menuH > window.innerHeight && rect.top - gap - menuH > 0;
    const top = flipUp ? rect.top - gap - menuH : below;
    setPos(
      align === "end" ? { top, right: window.innerWidth - rect.right } : { top, left: rect.left },
    );
  }, [align]);

  // Position before paint to avoid a flash at the wrong spot, then keep it pinned
  // to the trigger while open (scroll/resize).
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    computePosition();
    const onChange = () => computePosition();
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
    };
  }, [open, computePosition]);

  // Focus the first item once the menu is positioned.
  useEffect(() => {
    if (!open || !pos) return;
    orderedItems(menuRef.current)[0]?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function focusReturnToTrigger() {
    triggerRef.current?.focus();
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = orderedItems(menuRef.current);
    if (items.length === 0) return;
    const current = document.activeElement as HTMLElement | null;
    const index = current ? items.indexOf(current) : -1;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setOpen(false);
        focusReturnToTrigger();
        break;
      case "Tab":
        setOpen(false);
        break;
      case "ArrowDown":
        event.preventDefault();
        // From no/last item, wrap to the first.
        items[index < 0 ? 0 : (index + 1) % items.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        // From no/first item, wrap to the last.
        items[index <= 0 ? items.length - 1 : index - 1]?.focus();
        break;
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
    }
  }

  return (
    <div className={cn("relative inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        className="grid size-8 cursor-pointer place-items-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <DotsThreeVertical size={18} weight="bold" aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            style={{
              position: "fixed",
              top: pos?.top ?? -9999,
              left: pos?.left,
              right: pos?.right,
              // Hide until positioned so it never paints at the wrong spot.
              visibility: pos ? "visible" : "hidden",
            }}
            className="z-50 min-w-44 rounded-lg border border-border bg-surface-raised p-1 shadow-[var(--shadow-popover)]"
          >
            <ActionMenuCtx.Provider value={{ close }}>{children}</ActionMenuCtx.Provider>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Document-order focusable menu items (skips disabled). */
function orderedItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
  );
}

const itemBase =
  "flex h-8 w-full items-center justify-start gap-2 rounded-md px-2 text-left text-xs font-medium " +
  "transition-colors duration-100 [transition-timing-function:var(--ease-out)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

const itemTones = {
  default: "text-muted hover:bg-surface-hover hover:text-fg focus-visible:bg-surface-hover",
  danger: "text-muted hover:bg-danger-subtle hover:text-danger focus-visible:bg-danger-subtle",
} as const;

export interface ActionMenuItemProps {
  children: ReactNode;
  /** Run on select; the menu closes afterward automatically. */
  onSelect?: () => void;
  /** Render as a link (e.g. "Open in new tab") instead of a button. */
  href?: string;
  target?: string;
  rel?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Native title — used to explain why a disabled item can't be used. */
  title?: string;
}

export function ActionMenuItem({
  children,
  onSelect,
  href,
  target,
  rel,
  icon,
  danger = false,
  disabled = false,
  title,
}: ActionMenuItemProps) {
  const ctx = useContext(ActionMenuCtx);
  const className = cn(itemBase, itemTones[danger ? "danger" : "default"]);

  if (href && !disabled) {
    return (
      <a
        role="menuitem"
        tabIndex={-1}
        href={href}
        target={target}
        rel={rel}
        title={title}
        className={className}
        onClick={() => ctx?.close()}
      >
        {icon}
        {children}
      </a>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      title={title}
      className={cn(className, disabled && "cursor-not-allowed opacity-40 hover:bg-transparent")}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
        ctx?.close();
      }}
    >
      {icon}
      {children}
    </button>
  );
}
