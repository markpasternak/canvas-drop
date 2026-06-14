import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { cn } from "../lib/cn.js";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow && <div className="text-xs font-medium text-subtle">{eyebrow}</div>}
        <h1 className="truncate text-[1.5rem] font-semibold leading-tight tracking-[-0.02em] text-fg">
          {title}
        </h1>
        {description && <p className="max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ className, children, ...props }: ComponentPropsWithoutRef<"section">) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-surface p-5 shadow-[var(--shadow-panel)] sm:p-6",
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

export const WorkspacePane = forwardRef<HTMLElement, ComponentPropsWithoutRef<"section">>(
  function WorkspacePane({ className, children, ...props }, ref) {
    return (
      <section
        ref={ref}
        className={cn(
          "min-h-0 min-w-0 overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-panel)]",
          className,
        )}
        {...props}
      >
        {children}
      </section>
    );
  },
);

export function PaneHeader({
  title,
  description,
  actions,
  leading,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-12 items-center justify-between gap-3 border-b border-border bg-surface-raised px-3 py-2",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-fg">{title}</div>
          {description && (
            <div className="truncate text-[0.6875rem] text-subtle">{description}</div>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

type NoticeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const noticeTones: Record<NoticeTone, string> = {
  neutral: "border-border bg-surface-raised text-muted",
  accent: "border-accent/25 bg-accent-subtle text-accent",
  success: "border-success/25 bg-success-subtle text-success",
  warning: "border-warning/30 bg-warning-subtle text-warning",
  danger: "border-danger/30 bg-danger-subtle text-danger",
};

export function InlineNotice({
  tone = "neutral",
  className,
  children,
}: {
  tone?: NoticeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3.5 py-3 text-sm leading-relaxed",
        noticeTones[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MetaGrid({ className, children }: { className?: string; children: ReactNode }) {
  return <dl className={cn("grid gap-4 sm:grid-cols-2", className)}>{children}</dl>;
}

export function MetaItem({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-[0.6875rem] font-medium text-subtle">{label}</dt>
      <dd className="min-w-0 text-sm text-fg tabular-nums">{children}</dd>
    </div>
  );
}

export function ActionRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description && <div className="text-xs leading-relaxed text-muted">{description}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}
