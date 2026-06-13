import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";

type Tone = "neutral" | "accent" | "success" | "danger" | "warning";

const tones: Record<Tone, string> = {
  neutral: "bg-canvas text-muted border-border",
  accent: "bg-accent-subtle text-accent border-transparent",
  success: "bg-success-subtle text-success border-transparent",
  danger: "bg-danger-subtle text-danger border-transparent",
  warning: "bg-success-subtle text-warning border-transparent",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Canvas status → a tone + dot, reused in list + detail. */
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: Tone; label: string }> = {
    active: { tone: "success", label: "Active" },
    disabled: { tone: "danger", label: "Disabled" },
    deleted: { tone: "neutral", label: "Deleted" },
  };
  const s = map[status] ?? { tone: "neutral" as Tone, label: status };
  return (
    <Badge tone={s.tone}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {s.label}
    </Badge>
  );
}
