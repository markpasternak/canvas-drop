import { useEffect, useId, useState } from "react";
import { cn } from "../lib/cn.js";
import { cosmeticSlug, slugPreviewUrl } from "../lib/cosmetic-slug.js";
import { inputControl } from "../lib/input-styles.js";
import { type SlugStatus, useSlugAvailability } from "../lib/use-slug-availability.js";

const control = inputControl;

/** A status message + tone for each terminal/transient state. `idle` renders the hint. */
function statusMessage(status: SlugStatus): { text: string; tone: "muted" | "danger" } | null {
  switch (status) {
    case "checking":
      return { text: "Checking availability…", tone: "muted" };
    case "taken":
      return { text: "That slug is taken — try another.", tone: "danger" };
    case "invalid":
      return { text: "Use lowercase letters, numbers, and hyphens.", tone: "danger" };
    case "reserved":
      return { text: "That word is reserved — pick another.", tone: "danger" };
    default:
      return null;
  }
}

export interface SlugFieldProps {
  /** Instance URL config for the preview (from `/api/me`). Preview is hidden until known. */
  instance: { urlMode: "path" | "subdomain"; baseUrl: string } | undefined;
  /** Fires whenever the resolved slug or its status changes. */
  onResolved: (r: { slug: string; status: SlugStatus }) => void;
  label?: string;
  /** Helper shown in the idle state (e.g. "Leave empty for a random URL"). */
  idleHint?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

/**
 * Shared slug input (plan 004, U10) for the create form and the rename dialog. Owns
 * cosmetic normalization, the debounced availability check, the live URL preview, and
 * an `aria-live` status region. The parent reads `{ slug, status }` via `onResolved` to
 * gate its submit (allow when slug is empty or `available`).
 */
export function SlugField({
  instance,
  onResolved,
  label = "Slug",
  idleHint = "Leave empty for a random URL.",
  autoFocus,
  disabled,
}: SlugFieldProps) {
  const id = useId();
  const statusId = useId();
  const [raw, setRaw] = useState("");
  const slug = cosmeticSlug(raw);
  const status = useSlugAvailability(slug);

  useEffect(() => {
    onResolved({ slug, status });
  }, [slug, status, onResolved]);

  const msg = statusMessage(status);
  // Show the preview once the slug is grammatically plausible (not invalid/reserved).
  const showPreview = slug !== "" && status !== "invalid" && status !== "reserved" && !!instance;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        <span className="text-xs text-subtle">optional</span>
      </div>
      <input
        id={id}
        className={cn(control, "font-mono")}
        value={raw}
        // In a Dialog, `data-autofocus` is what the focus-trap targets on open.
        data-autofocus={autoFocus ? "" : undefined}
        disabled={disabled}
        placeholder="my-prototype"
        maxLength={63}
        aria-describedby={statusId}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setRaw(e.target.value)}
      />
      {/* Live region: announces availability/validation changes to screen readers. */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={cn("min-h-4 text-xs", msg?.tone === "danger" ? "text-danger" : "text-muted")}
      >
        {msg ? (
          msg.text
        ) : showPreview ? (
          <span className="font-mono text-muted">{slugPreviewUrl(slug, instance)}</span>
        ) : (
          idleHint
        )}
      </p>
    </div>
  );
}
