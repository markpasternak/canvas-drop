import { Check, Globe, Prohibit, ShieldChevron, XCircle } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import type { AdminPersonRow } from "../lib/api.js";
import { ApiError } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";
import {
  useAdminBlockUser,
  useAdminPromoteUser,
  useAdminPublishPublic,
  useCancelPendingInvitation,
} from "../lib/mutations.js";
import { ActionMenu, ActionMenuItem } from "./ActionMenu.js";
import { Badge } from "./Badge.js";
import { DataTable } from "./DataTable.js";
import { useToast } from "./Toast.js";

const MENU_ICON = 15;

/** Per-row governance actions in one overflow menu: grant/revoke public, promote/
 *  demote, block/unblock. Self-protection is surfaced here (items disabled for your
 *  own row) AND enforced server-side; the last-admin guard can only fail
 *  server-side, so it arrives as a toast. */
function RowActions({ person, meId }: { person: AdminPersonRow; meId: string | undefined }) {
  const block = useAdminBlockUser();
  const promote = useAdminPromoteUser();
  const publishPublic = useAdminPublishPublic();
  const cancelPending = useCancelPendingInvitation();
  const toast = useToast();
  const userId = person.userId;
  const isSelf = userId === meId;
  const firstPending = person.pendingGrants[0];

  if (!userId && !firstPending) return <span className="text-subtle">—</span>;

  async function togglePublic() {
    if (!userId) return;
    try {
      await publishPublic.mutateAsync({
        id: userId,
        allowed: person.canPublishPublic !== true,
      });
      toast(
        person.canPublishPublic === true
          ? "Public publishing revoked"
          : "Public publishing restored",
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update", "error");
    }
  }

  async function togglePromote() {
    if (!userId) return;
    try {
      await promote.mutateAsync({ id: userId, admin: !person.isAdmin });
      toast(person.isAdmin ? "Admin access removed" : "Promoted to admin");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update admin access", "error");
    }
  }

  async function toggleBlock() {
    if (!userId) return;
    try {
      await block.mutateAsync({ id: userId, blocked: !person.isBlocked });
      toast(person.isBlocked ? "User unblocked" : "User blocked");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update block status", "error");
    }
  }

  async function cancelFirstPending() {
    if (!firstPending) return;
    try {
      await cancelPending.mutateAsync(firstPending.id);
      toast("Pending grant canceled");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't cancel pending grant", "error");
    }
  }

  return (
    <ActionMenu label={`Actions for ${person.name || person.email}`}>
      {firstPending && (
        <ActionMenuItem
          danger
          icon={<XCircle size={MENU_ICON} aria-hidden />}
          title="Cancel this unconsumed pending grant"
          onSelect={cancelFirstPending}
        >
          Cancel pending grant
        </ActionMenuItem>
      )}
      {userId && (
        <>
          <ActionMenuItem
            icon={<Globe size={MENU_ICON} aria-hidden />}
            title="Revoke or restore this account's ability to publish canvases as static public links"
            onSelect={togglePublic}
          >
            {person.canPublishPublic === true
              ? "Revoke public publishing"
              : "Restore public publishing"}
          </ActionMenuItem>
          <ActionMenuItem
            icon={<ShieldChevron size={MENU_ICON} aria-hidden />}
            // You can't demote yourself; promoting yourself is a no-op but harmless.
            disabled={isSelf && person.isAdmin}
            title={isSelf && person.isAdmin ? "You can't remove your own admin access" : undefined}
            onSelect={togglePromote}
          >
            {person.isAdmin ? "Remove admin access" : "Promote to admin"}
          </ActionMenuItem>
          <ActionMenuItem
            danger={!person.isBlocked}
            icon={
              person.isBlocked ? (
                <Check size={MENU_ICON} aria-hidden />
              ) : (
                <Prohibit size={MENU_ICON} aria-hidden />
              )
            }
            disabled={isSelf}
            title={isSelf ? "You can't block yourself" : undefined}
            onSelect={toggleBlock}
          >
            {person.isBlocked ? "Unblock user" : "Block user"}
          </ActionMenuItem>
        </>
      )}
    </ActionMenu>
  );
}

/** Admin user-management table (plan 006) — identity + governance facts only.
 *  Columns: user, owned canvases, role, status, last seen, actions. No per-user
 *  behavioral data (governance without surveillance); `Last seen` is a deliberate
 *  admin-hygiene exception. */
export function AdminUserTable({
  people,
  meId,
}: {
  people: AdminPersonRow[];
  meId: string | undefined;
}) {
  const navigate = useNavigate();

  function viewCanvases(person: AdminPersonRow) {
    navigate({ to: "/admin/canvases", search: () => ({ person: person.email, page: 1 }) });
  }

  return (
    <DataTable
      columns={[
        { header: "User" },
        { header: "Owned", align: "right" },
        { header: "Role" },
        { header: "Status" },
        { header: "Public" },
        { header: "Last seen" },
        { srOnly: "Actions" },
      ]}
    >
      {people.map((u) => (
        <tr key={u.email} className="align-middle">
          <td className="px-3 py-2">
            <div className="font-medium text-fg">
              {u.name || u.email}
              {u.userId === meId && <span className="ml-2 text-xs text-subtle">(you)</span>}
            </div>
            <div className="text-xs text-muted">{u.email}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              <Badge tone={u.kind === "org_member" ? "success" : "neutral"}>
                {u.kind === "org_member"
                  ? "Org member"
                  : u.kind === "pending"
                    ? "Pending sign-in"
                    : "External"}
              </Badge>
              {u.permitId && <Badge tone="accent">Sign-in permit</Badge>}
              {u.pendingCount > 0 && <Badge tone="warning">{u.pendingCount} pending</Badge>}
            </div>
          </td>
          <td className="px-3 py-2 text-right text-muted">
            <div className="flex items-center justify-end gap-2">
              <span className="tabular-nums">{u.canvasCount.toLocaleString()}</span>
              <button
                type="button"
                onClick={() => viewCanvases(u)}
                className="rounded-md px-2 py-1 text-sm font-medium text-accent transition-colors hover:bg-accent-subtle hover:underline"
                aria-label={`View canvases involving ${u.email}`}
              >
                View
              </button>
            </div>
          </td>
          <td className="px-3 py-2">
            {u.isAdmin ? (
              <Badge tone="accent">Admin</Badge>
            ) : (
              <span className="text-subtle">—</span>
            )}
          </td>
          <td className="px-3 py-2">
            {!u.userId ? (
              <Badge tone="warning">Pending</Badge>
            ) : u.isBlocked ? (
              <Badge tone="danger">Blocked</Badge>
            ) : (
              <Badge tone="success">Active</Badge>
            )}
          </td>
          <td className="px-3 py-2">
            {u.canPublishPublic === null ? (
              <span className="text-subtle">—</span>
            ) : u.canPublishPublic ? (
              <Badge tone="success">Allowed</Badge>
            ) : (
              <Badge tone="danger">Revoked</Badge>
            )}
          </td>
          <td className="px-3 py-2 text-muted">
            {u.lastSeenAt !== null ? relativeTime(u.lastSeenAt) : "never"}
          </td>
          <td className="px-3 py-2 text-right">
            <RowActions person={u} meId={meId} />
          </td>
        </tr>
      ))}
    </DataTable>
  );
}
