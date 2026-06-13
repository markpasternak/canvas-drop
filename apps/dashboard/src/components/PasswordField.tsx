import { Check, CopySimple, Eye, EyeSlash } from "@phosphor-icons/react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { useId, useState } from "react";
import { cn } from "../lib/cn.js";
import { useToast } from "./Toast.js";

/** Trailing icon button living inside the input's right edge. */
function Adornment({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-7 w-7 place-items-center rounded text-muted transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:text-fg focus:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:hover:text-muted"
    >
      {children}
    </button>
  );
}

export interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  hint?: ReactNode;
  description?: ReactNode;
  /** Current value (controlled). Reveal/copy act on this. */
  value: string;
  /** Optionally control the reveal state (e.g. force-show right after Generate). */
  revealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
}

/**
 * Password input with best-practice affordances: an inline show/hide toggle and
 * a copy button, both acting on what you're typing right now. Stored passwords
 * are hashed at rest and can never be read back, so the only chance to see or
 * copy a password is while you set it (same model as the canvas key, §6.9.5).
 */
export function PasswordField({
  label,
  hint,
  description,
  value,
  revealed: revealedProp,
  onRevealedChange,
  className,
  ...rest
}: PasswordFieldProps) {
  const id = useId();
  const toast = useToast();
  const [revealedInternal, setRevealedInternal] = useState(false);
  const revealed = revealedProp ?? revealedInternal;
  const setRevealed = (next: boolean) => {
    setRevealedInternal(next);
    onRevealedChange?.(next);
  };
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast("Password copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Couldn't copy. Copy it manually.", "error");
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {hint && <span className="text-xs text-subtle">{hint}</span>}
      </div>
      <div className="relative">
        <input
          id={id}
          // type=text when revealed; keep autofill/managers from treating the
          // revealed value as a login field.
          type={revealed ? "text" : "password"}
          value={value}
          className={cn(
            "w-full rounded-md border border-border-strong bg-surface-raised py-2 pl-3 pr-[4.5rem] text-sm text-fg",
            "placeholder:text-subtle transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
            "focus:border-accent focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50",
            revealed && "font-mono",
            className,
          )}
          {...rest}
        />
        <div className="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
          <Adornment
            label={value ? "Copy password" : "Nothing to copy yet"}
            onClick={copy}
            disabled={!value}
          >
            {copied ? (
              <Check size={15} weight="bold" aria-hidden />
            ) : (
              <CopySimple size={15} weight="bold" aria-hidden />
            )}
          </Adornment>
          <Adornment
            label={revealed ? "Hide password" : "Show password"}
            onClick={() => setRevealed(!revealed)}
            disabled={!value}
          >
            {revealed ? (
              <EyeSlash size={15} weight="bold" aria-hidden />
            ) : (
              <Eye size={15} weight="bold" aria-hidden />
            )}
          </Adornment>
        </div>
      </div>
      {description && <p className="text-xs text-muted">{description}</p>}
    </div>
  );
}
