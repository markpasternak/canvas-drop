import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  Check,
  Copy,
  Prohibit,
  Star,
  UserSwitch,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { AdminCanvasRow } from "../lib/api.js";
import { ApiError } from "../lib/api.js";
import { useClipboardCopy } from "../lib/clipboard.js";
import { daysSince, formatBytes, relativeTime } from "../lib/format.js";
import {
  useAdminDisableCanvas,
  useAdminEnableCanvas,
  useAdminReassignOwner,
  useAdminRestoreCanvas,
  useSetFeatured,
} from "../lib/mutations.js";
import { useAdminUsers } from "../lib/queries.js";
import { rowPrimaryActionClass } from "../lib/row-styles.js";
import { ActionMenu, ActionMenuItem } from "./ActionMenu.js";
import { AccessBadge, Badge, ConceptBadge, StatusBadge } from "./Badge.js";
import { Button } from "./Button.js";
import { DataTable } from "./DataTable.js";
import { Dialog } from "./Dialog.js";
import { Field, TextareaField } from "./Field.js";
import { useToast } from "./Toast.js";

const MENU_ICON = 15;

/** Server cap on the takedown reason (routes/admin.ts disableBody.max). */
const REASON_MAX = 500;

function exposureFor(canvas: AdminCanvasRow): AdminCanvasRow["exposure"] {
  return (
    canvas.exposure ?? {
      specificPeopleCount: 0,
      teamCount: 0,
      pendingInviteCount: 0,
      externalPeopleCount: 0,
    }
  );
}

/** Reason-capturing takedown dialog (§6.10.2 — the reason the owner later sees). */
function TakedownDialog({
  canvas,
  open,
  onClose,
}: {
  canvas: AdminCanvasRow;
  open: boolean;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const disable = useAdminDisableCanvas();
  const toast = useToast();
  return (
    <Dialog open={open} onClose={onClose} title={`Disable “${canvas.title || canvas.slug}”`}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          The public URL will show a “disabled” page. The owner sees the reason below in their
          dashboard.
        </p>
        <TextareaField
          label="Reason"
          placeholder="Why is this being taken down?"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
          maxLength={REASON_MAX}
          rows={3}
          hint={`${reason.length}/${REASON_MAX}`}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={disable.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={disable.isPending}
            disabled={reason.trim().length === 0}
            onClick={async () => {
              try {
                await disable.mutateAsync({ id: canvas.id, reason: reason.trim() });
                toast("Canvas disabled");
                onClose();
              } catch (err) {
                toast(err instanceof ApiError ? err.hint : "Couldn't disable", "error");
              }
            }}
          >
            Disable canvas
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Reassign-owner dialog (editor-roles plan U7, R14): pick another member (admin
 * user directory search), give a reason, confirm. The server refuses the current
 * owner, a blocked account, a non-member of the canvas's org, and the acting admin.
 */
function ReassignDialog({
  canvas,
  open,
  onClose,
}: {
  canvas: AdminCanvasRow;
  open: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<{ id: string; email: string; name: string } | null>(null);
  const [reason, setReason] = useState("");
  const reassign = useAdminReassignOwner();
  const toast = useToast();
  const users = useAdminUsers({ q: q.trim() || undefined, limit: 8 });
  const candidates = (users.data?.users ?? []).filter(
    (u) => !u.isBlocked && u.id !== canvas.owner?.id,
  );
  return (
    <Dialog open={open} onClose={onClose} title={`Reassign “${canvas.title || canvas.slug}”`}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Moves ownership from {canvas.owner?.email ?? "the current owner"} to another member. The
          previous owner stays on as an editor when their account is active; the deploy key is
          rotated and the new owner issues a fresh one.
        </p>
        <Field
          label="New owner"
          placeholder="Search members by name or email"
          value={target ? `${target.name} <${target.email}>` : q}
          onChange={(e) => {
            setTarget(null);
            setQ(e.target.value);
          }}
        />
        {!target && q.trim().length > 0 && (
          <ul className="max-h-48 divide-y divide-border overflow-auto rounded-lg border border-border">
            {candidates.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted">No matching members</li>
            )}
            {candidates.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-surface-2"
                  onClick={() => setTarget({ id: u.id, email: u.email, name: u.name })}
                >
                  <span className="font-medium">{u.name}</span>
                  <span className="text-xs text-muted">{u.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <TextareaField
          label="Reason"
          placeholder="Why is ownership moving? (recorded in the audit log)"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
          maxLength={REASON_MAX}
          rows={3}
          hint={`${reason.length}/${REASON_MAX}`}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={reassign.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={reassign.isPending}
            disabled={!target || reason.trim().length === 0}
            onClick={async () => {
              if (!target) return;
              try {
                const r = await reassign.mutateAsync({
                  id: canvas.id,
                  toUserId: target.id,
                  reason: reason.trim(),
                });
                toast(
                  r.publicLinkReverted
                    ? `Reassigned to ${target.email}; the public link was turned off (their account can't publish publicly)`
                    : `Reassigned to ${target.email}`,
                );
                onClose();
              } catch (err) {
                toast(err instanceof ApiError ? err.hint : "Couldn't reassign", "error");
              }
            }}
          >
            Reassign owner
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** All row actions in one overflow menu — the dense-table best practice (every
 *  per-row action behind a kebab). The status action (Disable/Enable/Restore)
 *  joins the navigation/copy actions in the same menu; archived canvases are
 *  owner-controlled, so they get only the navigation actions. */
function RowActions({ canvas }: { canvas: AdminCanvasRow }) {
  const [takedownOpen, setTakedownOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const enable = useAdminEnableCanvas();
  const restore = useAdminRestoreCanvas();
  const setFeatured = useSetFeatured();
  const copy = useClipboardCopy();
  const toast = useToast();

  // A canvas can only be featured while it's gallery-listed AND published — the gallery
  // featured row only shows such canvases. (Unfeature stays available regardless.)
  const canFeature = canvas.galleryListed && canvas.publicationState === "published";

  async function doFeature() {
    const next = !canvas.galleryFeatured;
    try {
      await setFeatured.mutateAsync({ id: canvas.id, featured: next });
      toast(next ? "Canvas featured in the gallery" : "Removed from featured");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update featured", "error");
    }
  }

  async function doEnable() {
    try {
      await enable.mutateAsync(canvas.id);
      toast("Canvas re-enabled");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't enable", "error");
    }
  }

  async function doRestore() {
    try {
      await restore.mutateAsync(canvas.id);
      toast("Canvas restored");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't restore", "error");
    }
  }

  return (
    <>
      <ActionMenu label={`Actions for ${canvas.title || canvas.slug}`}>
        <ActionMenuItem
          icon={<Copy size={MENU_ICON} aria-hidden />}
          onSelect={() => copy(canvas.url, "Link copied")}
        >
          Copy link
        </ActionMenuItem>
        {/* Admin-curated gallery feature (KTD3) — a cross-owner editorial toggle.
            Label by current state so a single item both features and unfeatures.
            Featuring requires the canvas to be gallery-listed + published (the gallery
            featured row only shows such canvases; the server enforces the same), so the
            Feature action is disabled with a hint otherwise. Unfeature is always live. */}
        <ActionMenuItem
          icon={
            <Star
              size={MENU_ICON}
              weight={canvas.galleryFeatured ? "fill" : "regular"}
              aria-hidden
            />
          }
          onSelect={doFeature}
          disabled={!canvas.galleryFeatured && !canFeature}
          title={
            !canvas.galleryFeatured && !canFeature
              ? "Only gallery-listed canvases can be featured"
              : undefined
          }
        >
          {canvas.galleryFeatured ? "Unfeature" : "Feature in gallery"}
        </ActionMenuItem>
        {/* Reassign owner (editor-roles plan U7): offboarding — move a canvas between
            other members with a reason. Not offered for a soft-deleted row (restore first). */}
        {canvas.status !== "deleted" && (
          <ActionMenuItem
            icon={<UserSwitch size={MENU_ICON} aria-hidden />}
            onSelect={() => setReassignOpen(true)}
          >
            Reassign owner
          </ActionMenuItem>
        )}
        {canvas.status === "active" && (
          <ActionMenuItem
            danger
            icon={<Prohibit size={MENU_ICON} aria-hidden />}
            onSelect={() => setTakedownOpen(true)}
          >
            Disable
          </ActionMenuItem>
        )}
        {canvas.status === "disabled" && (
          <ActionMenuItem icon={<Check size={MENU_ICON} aria-hidden />} onSelect={doEnable}>
            Enable
          </ActionMenuItem>
        )}
        {canvas.status === "deleted" && (
          <ActionMenuItem
            icon={<ArrowCounterClockwise size={MENU_ICON} aria-hidden />}
            onSelect={doRestore}
          >
            Restore
          </ActionMenuItem>
        )}
      </ActionMenu>
      <TakedownDialog canvas={canvas} open={takedownOpen} onClose={() => setTakedownOpen(false)} />
      <ReassignDialog canvas={canvas} open={reassignOpen} onClose={() => setReassignOpen(false)} />
    </>
  );
}

/** Can the current admin actually VIEW this canvas as a normal user? The admin's
 *  governance powers don't grant view access to another owner's restricted canvas,
 *  so "Open" (which loads the public URL as a user, access enforced server-side)
 *  would just hit a gate/404 for those. We only offer Open for a canvas the admin
 *  can genuinely open as a regular user:
 *
 *    - Only active canvases serve real content: a disabled / archived / deleted
 *      canvas shows a status page (or 404) to everyone — including its owner — so
 *      Open is hidden regardless of access or ownership.
 *    - The admin's OWN active canvas is always openable (they hold the grant).
 *    - For another owner's canvas, Open shows only when any org member could reach
 *      it: whole_org / public_link, AND it isn't password-gated, AND its share window
 *      hasn't expired. Restricted canvases (private and its legacy aliases) aren't
 *      knowable-reachable client-side (a grant to the admin isn't visible here), a
 *      password would just hit the unlock gate, and an expired share serves the
 *      expired page — so we hide Open in all of those and keep only the kebab. */
function adminCanView(canvas: AdminCanvasRow, viewerId: string | undefined): boolean {
  if (canvas.status !== "active") return false;
  // The admin's own active canvas is always openable.
  if (viewerId && canvas.owner?.id === viewerId) return true;
  // Another owner's canvas: must be org-reachable, unlocked, and unexpired.
  if (canvas.access !== "whole_org" && canvas.access !== "public_link") return false;
  if (canvas.hasPassword) return false;
  if (canvas.sharedExpiresAt != null && canvas.sharedExpiresAt < Date.now()) return false;
  return true;
}

/** All-canvases table (§6.10.1) — owner / status / size / usage / last-activity.
 *  `viewerId` is the current admin's user id, used to decide whether to offer the
 *  per-row "Open" action (see {@link adminCanView}). */
export function AdminCanvasTable({
  canvases,
  onOwnerClick,
  viewerId,
}: {
  canvases: AdminCanvasRow[];
  onOwnerClick?: (owner: NonNullable<AdminCanvasRow["owner"]>) => void;
  viewerId?: string;
}) {
  const navigate = useNavigate();
  const openCanvas = (id: string) => navigate({ to: "/canvases/$id", params: { id } });
  return (
    <DataTable
      columns={[
        { header: "Canvas" },
        { header: "Owner" },
        { header: "Access" },
        { header: "Status" },
        { header: "Size", align: "right" },
        { header: "Usage", align: "right" },
        { header: "Last activity" },
        { srOnly: "Actions" },
      ]}
    >
      {canvases.map((c) => (
        <tr key={c.id} className="align-middle">
          <td className="px-3 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => openCanvas(c.id)}
                className="rounded-sm text-left font-medium text-fg underline-offset-2 transition-colors hover:text-accent hover:underline"
                aria-label={`Open ${c.title || c.slug}`}
              >
                {c.title || c.slug}
              </button>
              {c.galleryFeatured && (
                <Badge tone="accent">
                  <Star size={11} weight="fill" aria-hidden />
                  Featured
                </Badge>
              )}
              {/* Gallery state, same badge vocabulary as the owner Your-canvases rows:
                  Template implies listed, so they're mutually exclusive here. */}
              {c.galleryTemplatable ? (
                <ConceptBadge concept="templates">Template</ConceptBadge>
              ) : c.galleryListed ? (
                <ConceptBadge concept="listed">Listed</ConceptBadge>
              ) : null}
            </div>
            <div className="font-mono text-xs text-muted">{c.slug}</div>
            {c.disabledReason && (
              <div className="mt-0.5 text-xs text-danger">{c.disabledReason}</div>
            )}
            {c.status === "deleted" && c.deletedAt !== null && (
              <div
                className="mt-0.5 text-xs text-subtle"
                title={`Deleted ${relativeTime(c.deletedAt)}`}
              >
                Deleted {daysSince(c.deletedAt)}d ago · awaiting purge
              </div>
            )}
          </td>
          <td className="px-3 py-2 text-muted">
            {c.owner && onOwnerClick ? (
              <button
                type="button"
                onClick={() => onOwnerClick?.(c.owner as NonNullable<AdminCanvasRow["owner"]>)}
                className="rounded-md px-1 py-0.5 text-left text-accent transition-colors hover:bg-accent-subtle hover:underline"
              >
                {c.owner.email}
              </button>
            ) : c.owner ? (
              c.owner.email
            ) : (
              "—"
            )}
          </td>
          <td className="px-3 py-2">
            <div className="flex max-w-64 flex-wrap gap-1.5">
              <AccessBadge access={c.access} />
              {c.context && (
                <Badge tone="neutral">
                  {c.context === "team" ? "Team" : c.context === "org" ? "Org" : "Personal"}
                </Badge>
              )}
              {c.access === "public_link" &&
                (c.publicLinkEffective ? (
                  <Badge tone="success">Effective public</Badge>
                ) : (
                  <Badge tone="danger">
                    {c.ownerCanPublishPublic === false ? "Owner revoked" : "Public disabled"}
                  </Badge>
                ))}
              {c.hasPassword && <Badge tone="warning">Password</Badge>}
              {c.expiryState === "active" && <Badge tone="warning">Expires</Badge>}
              {c.expiryState === "expired" && <Badge tone="danger">Expired</Badge>}
              {exposureFor(c).teamCount > 0 && (
                <Badge tone="accent">{exposureFor(c).teamCount} teams</Badge>
              )}
              {exposureFor(c).specificPeopleCount > 0 && (
                <Badge tone="accent">{exposureFor(c).specificPeopleCount} people</Badge>
              )}
              {exposureFor(c).externalPeopleCount > 0 && (
                <Badge tone="warning">{exposureFor(c).externalPeopleCount} external</Badge>
              )}
              {exposureFor(c).pendingInviteCount > 0 && (
                <Badge tone="warning">{exposureFor(c).pendingInviteCount} pending access</Badge>
              )}
            </div>
          </td>
          <td className="px-3 py-2">
            <StatusBadge status={c.status} />
          </td>
          <td className="px-3 py-2 text-right tabular-nums text-muted">
            {formatBytes(c.sizeBytes)}
          </td>
          <td className="px-3 py-2 text-right tabular-nums text-muted">
            {c.usageOps.toLocaleString()}
          </td>
          <td className="px-3 py-2 text-muted">{relativeTime(c.lastActivityAt)}</td>
          <td className="px-3 py-2">
            {/* Open the canvas's public URL in a new tab — the admin views it as a
                normal user; access is enforced server-side at view time. Only offered
                for canvases the admin can actually reach (see adminCanView): another
                owner's private/specific-people canvas would just hit a gate/404, so we
                hide Open there and keep only the governance kebab. */}
            <div className="flex items-center justify-end gap-1.5">
              {adminCanView(c, viewerId) && (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className={rowPrimaryActionClass}
                  aria-label={`Open ${c.title || c.slug} in a new tab`}
                >
                  <ArrowSquareOut size={14} aria-hidden />
                  Open
                </a>
              )}
              <RowActions canvas={c} />
            </div>
          </td>
        </tr>
      ))}
    </DataTable>
  );
}
