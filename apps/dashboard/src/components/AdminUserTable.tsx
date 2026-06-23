import { Check, Globe, Prohibit, ShieldChevron } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import type { AdminUserRow } from "../lib/api.js";
import { ApiError } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";
import { useAdminBlockUser, useAdminPromoteUser, useAdminPublishPublic } from "../lib/mutations.js";
import { ActionMenu, ActionMenuItem } from "./ActionMenu.js";
import { Badge } from "./Badge.js";
import { DataTable } from "./DataTable.js";
import { useToast } from "./Toast.js";

const MENU_ICON = 15;

/** Per-row governance actions in one overflow menu: grant/revoke public, promote/
 *  demote, block/unblock. Self-protection is surfaced here (items disabled for your
 *  own row) AND enforced server-side; the last-admin guard can only fail
 *  server-side, so it arrives as a toast. */
function RowActions({ user, meId }: { user: AdminUserRow; meId: string | undefined }) {
  const block = useAdminBlockUser();
  const promote = useAdminPromoteUser();
  const publishPublic = useAdminPublishPublic();
  const toast = useToast();
  const isSelf = user.id === meId;

  async function togglePublic() {
    try {
      await publishPublic.mutateAsync({ id: user.id, allowed: !user.canPublishPublic });
      toast(user.canPublishPublic ? "Public publishing revoked" : "Public publishing restored");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update", "error");
    }
  }

  async function togglePromote() {
    try {
      await promote.mutateAsync({ id: user.id, admin: !user.isAdmin });
      toast(user.isAdmin ? "Admin access removed" : "Promoted to admin");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update admin access", "error");
    }
  }

  async function toggleBlock() {
    try {
      await block.mutateAsync({ id: user.id, blocked: !user.isBlocked });
      toast(user.isBlocked ? "User unblocked" : "User blocked");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update block status", "error");
    }
  }

  return (
    <ActionMenu label={`Actions for ${user.name || user.email}`}>
      <ActionMenuItem
        icon={<Globe size={MENU_ICON} aria-hidden />}
        title="Revoke or restore this account's ability to publish canvases as static public links"
        onSelect={togglePublic}
      >
        {user.canPublishPublic ? "Revoke public publishing" : "Restore public publishing"}
      </ActionMenuItem>
      <ActionMenuItem
        icon={<ShieldChevron size={MENU_ICON} aria-hidden />}
        // You can't demote yourself; promoting yourself is a no-op but harmless.
        disabled={isSelf && user.isAdmin}
        title={isSelf && user.isAdmin ? "You can't remove your own admin access" : undefined}
        onSelect={togglePromote}
      >
        {user.isAdmin ? "Remove admin access" : "Promote to admin"}
      </ActionMenuItem>
      <ActionMenuItem
        danger={!user.isBlocked}
        icon={
          user.isBlocked ? (
            <Check size={MENU_ICON} aria-hidden />
          ) : (
            <Prohibit size={MENU_ICON} aria-hidden />
          )
        }
        disabled={isSelf}
        title={isSelf ? "You can't block yourself" : undefined}
        onSelect={toggleBlock}
      >
        {user.isBlocked ? "Unblock user" : "Block user"}
      </ActionMenuItem>
    </ActionMenu>
  );
}

/** Admin user-management table (plan 006) — identity + governance facts only.
 *  Columns: user, owned canvases, role, status, last seen, actions. No per-user
 *  behavioral data (governance without surveillance); `Last seen` is a deliberate
 *  admin-hygiene exception. */
export function AdminUserTable({
  users,
  meId,
}: {
  users: AdminUserRow[];
  meId: string | undefined;
}) {
  const navigate = useNavigate();

  function viewCanvases(user: AdminUserRow) {
    navigate({ to: "/admin/canvases", search: () => ({ owner: user.id, page: 1 }) });
  }

  return (
    <DataTable
      columns={[
        { header: "User" },
        { header: "Canvases", align: "right" },
        { header: "Role" },
        { header: "Status" },
        { header: "Last seen" },
        { srOnly: "Actions" },
      ]}
    >
      {users.map((u) => (
        <tr key={u.id} className="align-middle">
          <td className="px-3 py-2">
            <div className="font-medium text-fg">
              {u.name || u.email}
              {u.id === meId && <span className="ml-2 text-xs text-subtle">(you)</span>}
            </div>
            <div className="text-xs text-muted">{u.email}</div>
          </td>
          <td className="px-3 py-2 text-right text-muted">
            <div className="flex items-center justify-end gap-2">
              <span className="tabular-nums">{u.canvasCount.toLocaleString()}</span>
              <button
                type="button"
                onClick={() => viewCanvases(u)}
                className="rounded-md px-2 py-1 text-sm font-medium text-accent transition-colors hover:bg-accent-subtle hover:underline"
                aria-label={`View canvases owned by ${u.email}`}
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
            {u.isBlocked ? (
              <Badge tone="danger">Blocked</Badge>
            ) : (
              <Badge tone="success">Active</Badge>
            )}
          </td>
          <td className="px-3 py-2 text-muted">
            {u.lastSeenAt !== null ? relativeTime(u.lastSeenAt) : "never"}
          </td>
          <td className="px-3 py-2 text-right">
            <RowActions user={u} meId={meId} />
          </td>
        </tr>
      ))}
    </DataTable>
  );
}
