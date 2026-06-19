import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  Check,
  Copy,
  Prohibit,
  Star,
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
  useAdminRestoreCanvas,
  useSetFeatured,
} from "../lib/mutations.js";
import { rowPrimaryActionClass } from "../lib/row-styles.js";
import { ActionMenu, ActionMenuItem } from "./ActionMenu.js";
import { AccessBadge, Badge, ConceptBadge, StatusBadge } from "./Badge.js";
import { Button } from "./Button.js";
import { DataTable } from "./DataTable.js";
import { Dialog } from "./Dialog.js";
import { TextareaField } from "./Field.js";
import { useToast } from "./Toast.js";

const MENU_ICON = 15;

/** Server cap on the takedown reason (routes/admin.ts disableBody.max). */
const REASON_MAX = 500;

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

/** All row actions in one overflow menu — the dense-table best practice (every
 *  per-row action behind a kebab). The status action (Disable/Enable/Restore)
 *  joins the navigation/copy actions in the same menu; archived canvases are
 *  owner-controlled, so they get only the navigation actions. */
function RowActions({ canvas }: { canvas: AdminCanvasRow }) {
  const [takedownOpen, setTakedownOpen] = useState(false);
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
    </>
  );
}

/** All-canvases table (§6.10.1) — owner / status / size / usage / last-activity. */
export function AdminCanvasTable({
  canvases,
  onOwnerClick,
}: {
  canvases: AdminCanvasRow[];
  onOwnerClick?: (owner: NonNullable<AdminCanvasRow["owner"]>) => void;
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
            <AccessBadge access={c.access} />
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
                normal user; access is enforced server-side at view time, so we just
                offer the link. Mirrors the owner row's primary action + overflow menu. */}
            <div className="flex items-center justify-end gap-1.5">
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
              <RowActions canvas={c} />
            </div>
          </td>
        </tr>
      ))}
    </DataTable>
  );
}
