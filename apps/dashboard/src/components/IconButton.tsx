import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../lib/cn.js";

type Tone = "default" | "accent" | "danger";
type Size = "sm" | "md";

const base =
  "inline-grid place-items-center rounded-md border font-medium transition-all duration-100 " +
  "[transition-timing-function:var(--ease-out)] active:translate-y-px " +
  "disabled:pointer-events-none disabled:opacity-40";

const tones: Record<Tone, string> = {
  default: "border-transparent text-muted hover:bg-surface-hover hover:text-fg",
  accent: "border-transparent bg-accent text-accent-fg hover:bg-accent-hover",
  danger: "border-transparent text-danger hover:bg-danger-subtle hover:text-danger",
};

const sizes: Record<Size, string> = {
  sm: "size-8 text-[0.8125rem]",
  md: "size-9 text-sm",
};

export interface IconButtonProps extends ComponentPropsWithoutRef<"button"> {
  label: string;
  tone?: Tone;
  size?: Size;
  children: ReactNode;
}

/** Accessible icon-only button. The native title provides a lightweight tooltip. */
export function IconButton({
  label,
  tone = "default",
  size = "sm",
  className,
  children,
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(base, tones[tone], sizes[size], className)}
      {...props}
    >
      {children}
    </button>
  );
}

export interface IconLinkProps extends ComponentPropsWithoutRef<"a"> {
  label: string;
  tone?: Tone;
  size?: Size;
  children: ReactNode;
}

export function IconLink({
  label,
  tone = "default",
  size = "sm",
  className,
  children,
  ...props
}: IconLinkProps) {
  return (
    <a title={label} className={cn(base, tones[tone], sizes[size], className)} {...props}>
      <span className="sr-only">{label}</span>
      {children}
    </a>
  );
}
