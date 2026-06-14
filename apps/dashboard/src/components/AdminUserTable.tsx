import { useNavigate } from "@tanstack/react-router";
import type { AdminUserRow } from "../lib/api.js";
import { ApiError } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";
import { useAdminBlockUser, useAdminPromoteUser } from "../lib/mutations.js";
import { Badge } from "./Badge.js";
import { Button } from "./Button.js";
import { useToast } from "./Toast.js";

/** Per-row governance actions: block/unblock + promote/demote. Self-protection is
 *  surfaced here (buttons disabled for your own row) AND enforced server-side; the
 *  last-admin guard can only fail server-side, so it arrives as a toast. */
function RowActions({ user, meId }: { user: AdminUserRow; meId: string | undefined }) {
  const block = useAdminBlockUser();
  const promote = useAdminPromoteUser();
  const toast = useToast();
  const isSelf = user.id === meId;

  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        size="sm"
        variant="secondary"
        loading={promote.isPending}
        // You can't demote yourself; promoting yourself is a no-op but harmless.
        disabled={isSelf && user.isAdmin}
        title={isSelf && user.isAdmin ? "You can't remove your own admin access" : undefined}
        onClick={async () => {
          try {
            await promote.mutateAsync({ id: user.id, admin: !user.isAdmin });
            toast(user.isAdmin ? "Admin access removed" : "Promoted to admin");
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't update admin access", "error");
          }
        }}
      >
        {user.isAdmin ? "Demote" : "Promote"}
      </Button>
      <Button
        size="sm"
        variant={user.isBlocked ? "secondary" : "danger"}
        loading={block.isPending}
        disabled={isSelf}
        title={isSelf ? "You can't block yourself" : undefined}
        onClick={async () => {
          try {
            await block.mutateAsync({ id: user.id, blocked: !user.isBlocked });
            toast(user.isBlocked ? "User unblocked" : "User blocked");
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't update block status", "error");
          }
        }}
      >
        {user.isBlocked ? "Unblock" : "Block"}
      </Button>
    </div>
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
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-border border-b bg-surface-sunken text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">User</th>
            <th className="px-3 py-2 text-right font-medium">Canvases</th>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Last seen</th>
            <th className="px-3 py-2 font-medium" aria-label="Actions" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
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
        </tbody>
      </table>
    </div>
  );
}
