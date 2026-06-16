import { CaretDown, Info, ShieldCheck, SignOut } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import type { Me } from "../lib/api.js";
import { cn } from "../lib/cn.js";

/** First letter of the display name, falling back to the email — a calm avatar
 * fallback when the identity provider gives no `avatarUrl`. Tolerates a null/absent
 * name or email (some providers omit one). */
function initial(me: Me): string {
  const source = me.name?.trim() || me.email?.trim() || "";
  return (source[0] ?? "?").toUpperCase();
}

/** Best display label for the account, never empty. */
function label(me: Me): string {
  return me.name?.trim() || me.email?.trim() || "Account";
}

/** Account control in the top bar: an avatar button that opens a popover with the
 * signed-in identity and (when the instance owns a revocable session) Sign out.
 *
 * In `proxy` mode the trusted proxy owns identity and there is no app session to
 * revoke, so the menu omits Sign out and only surfaces who you are. Sign out is a
 * real navigation to the server `/auth/logout` redirect — not a fetch — so the
 * session cookie is cleared and the gateway re-challenges on the next load. */
export function UserMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const canSignOut = me.authMode !== "proxy";

  // Close on outside pointerdown and on Escape; restore focus to the trigger so
  // keyboard users aren't dumped at the top of the document.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account: ${label(me)}`}
        className={cn(
          "flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface-sunken pr-1.5 pl-1 text-muted transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:text-fg active:translate-y-px",
          open && "text-fg",
        )}
      >
        <Avatar me={me} className="size-7" />
        <CaretDown
          size={12}
          weight="bold"
          aria-hidden
          className={cn("transition-transform duration-100", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-60 origin-top-right overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-panel)]"
        >
          <div className="flex items-center gap-3 border-border border-b px-3.5 py-3">
            <Avatar me={me} className="size-9 text-sm" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-fg text-sm">{label(me)}</span>
                {me.isAdmin && (
                  <ShieldCheck
                    size={14}
                    weight="fill"
                    aria-label="Admin"
                    className="shrink-0 text-accent"
                  />
                )}
              </div>
              {me.name?.trim() && me.email && (
                <div className="truncate text-subtle text-xs">{me.email}</div>
              )}
            </div>
          </div>

          {/* Real navigation to the server-rendered public landing — not an SPA route. */}
          <a
            href="/welcome"
            role="menuitem"
            className="flex items-center gap-2.5 px-3.5 py-2.5 text-fg text-sm transition-colors hover:bg-surface-sunken"
          >
            <Info size={16} aria-hidden className="text-muted" />
            About canvas-drop
          </a>

          {canSignOut && (
            <a
              href="/auth/logout"
              role="menuitem"
              className="flex items-center gap-2.5 border-border border-t px-3.5 py-2.5 text-fg text-sm transition-colors hover:bg-surface-sunken"
            >
              <SignOut size={16} aria-hidden className="text-muted" />
              Sign out
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Avatar({ me, className }: { me: Me; className?: string }) {
  if (me.avatarUrl) {
    return (
      <img
        src={me.avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        className={cn("shrink-0 rounded-full bg-surface-sunken object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-accent-subtle font-semibold text-[0.8125rem] text-accent",
        className,
      )}
    >
      {initial(me)}
    </span>
  );
}
