import type { ReactNode } from "react";
import type { AccessRung, Canvas, PublicationState } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import type { Tone } from "./variants.js";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-raised text-muted border-border",
  accent: "bg-accent-subtle text-accent border-transparent",
  success: "bg-success-subtle text-success border-transparent",
  danger: "bg-danger-subtle text-danger border-transparent",
  warning: "bg-warning-subtle text-warning border-transparent",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Raw admin canvas status → a tone + dot (admin surfaces only — owner-facing
 *  views use {@link PublicationBadge} for the derived lifecycle). */
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: Tone; label: string }> = {
    active: { tone: "success", label: "Active" },
    disabled: { tone: "danger", label: "Disabled" },
    archived: { tone: "warning", label: "Archived" },
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

/** Derived canvas lifecycle (Draft/Published/Archived/Disabled) — the Publication
 *  axis. The single source readers see for "is this live?" across header + list. */
export function PublicationBadge({ state }: { state: PublicationState }) {
  const map: Record<PublicationState, { tone: Tone; label: string }> = {
    draft: { tone: "neutral", label: "Draft" },
    published: { tone: "success", label: "Published" },
    archived: { tone: "warning", label: "Archived" },
    disabled: { tone: "danger", label: "Disabled" },
    deleted: { tone: "neutral", label: "Deleted" },
  };
  const s = map[state];
  return (
    <Badge tone={s.tone}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {s.label}
    </Badge>
  );
}

/** Access axis (D4 ladder): who can reach the canvas. `public_link` is the only
 *  rung open beyond the org, so it reads as a distinct, attention-toned "Public"
 *  pill (with a dot) everywhere access is shown — owners and admins alike. */
const ACCESS_BADGE: Record<AccessRung, { tone: Tone; label: string; dot: boolean }> = {
  private: { tone: "neutral", label: "Private", dot: false },
  specific_people: { tone: "accent", label: "Specific people", dot: false },
  whole_org: { tone: "accent", label: "Whole org", dot: false },
  public_link: { tone: "warning", label: "Public", dot: true },
};

/** The canonical rung→label string (single source; reused by non-badge surfaces
 *  like the Status "Access" fact so the label can't drift). */
export function accessRungLabel(access: AccessRung): string {
  return (ACCESS_BADGE[access] ?? ACCESS_BADGE.private).label;
}

/** Options for an access-rung filter dropdown (owner + admin canvas lists), derived
 *  from ACCESS_BADGE so the rung labels never drift from the pills. `all` clears it. */
export const ACCESS_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All access" },
  ...(Object.keys(ACCESS_BADGE) as AccessRung[]).map((a) => ({
    value: a,
    label: ACCESS_BADGE[a].label,
  })),
];

export function AccessBadge({ access }: { access: AccessRung }) {
  const s = ACCESS_BADGE[access] ?? ACCESS_BADGE.private;
  return (
    <Badge tone={s.tone}>
      {s.dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {s.label}
    </Badge>
  );
}

/** Visibility axis (legacy boolean): kept for callers that only know `shared`. */
export function VisibilityBadge({ shared }: { shared: boolean }) {
  return <Badge tone={shared ? "accent" : "neutral"}>{shared ? "Shared" : "Private"}</Badge>;
}

/** Gallery axis: discovery state. Template implies listed; listed implies shared. */
export function GalleryBadge({
  canvas,
}: {
  canvas: Pick<Canvas, "galleryListed" | "galleryTemplatable">;
}) {
  if (canvas.galleryTemplatable) return <Badge tone="accent">Template</Badge>;
  if (canvas.galleryListed) return <Badge tone="neutral">Listed</Badge>;
  return <Badge tone="neutral">Unlisted</Badge>;
}
