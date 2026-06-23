import { useState } from "react";
import { ApiError } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";
import { useAddAllowedEmail, useRemoveAllowedEmail } from "../lib/mutations.js";
import { useAdminAllowedEmails } from "../lib/queries.js";
import { Button } from "./Button.js";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { useToast } from "./Toast.js";

/**
 * Admin sign-in permits (plan 003 U7) — the only way to permit a brand-new email to sign in.
 * Adding routes through the access primitive: it permits the email (an explicit entry below
 * when the domain doesn't already authenticate), sends a courtesy email, and — on a matching
 * org domain — makes them a member on their first verified login. There are no app-owned
 * passwords; the person signs in through the instance's configured auth.
 *
 * The list shows the off-domain permits an admin manages here (an on-domain email needs no
 * row — it already signs in via the domain allowlist).
 */
export function AddUsersPanel() {
  const { data: emails, isLoading } = useAdminAllowedEmails();
  const add = useAddAllowedEmail();
  const remove = useRemoveAllowedEmail();
  const toast = useToast();
  const [email, setEmail] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    try {
      const r = await add.mutateAsync(value);
      setEmail("");
      // `pending` = a brand-new email was permitted; they join on first sign-in. `granted` = an
      // existing user (nothing new to permit).
      toast(r.status === "pending" ? "Sign-in permit added" : "Email already permitted");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't add sign-in permit", "error");
    }
  }

  const count = emails?.length ?? 0;

  return (
    <CollapsibleSection
      title={`Sign-in permits${count > 0 ? ` (${count})` : ""}`}
      storageKey="admin:section:add-users"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <p className="text-muted text-xs">
          Permit an email outside your domain allowlist to sign in. This does not grant canvas
          access by itself; canvas and team access appears in the People table as pending access
          until that email signs in. Permits stay here until you remove them.
        </p>

        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1">
            <label htmlFor="add-user-email" className="font-medium text-subtle text-xs">
              Email to permit
            </label>
            <input
              id="add-user-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              className="mt-1 h-9 w-full rounded-lg border border-border bg-surface px-3 text-fg text-sm placeholder:text-subtle focus:border-border-strong focus:outline-none"
            />
          </div>
          <Button type="submit" size="sm" variant="secondary" loading={add.isPending}>
            Add permit
          </Button>
        </form>

        {isLoading ? (
          <p className="text-muted text-xs">Loading…</p>
        ) : emails && emails.length > 0 ? (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {emails.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium text-fg text-sm">{entry.email}</div>
                  <div className="text-subtle text-xs">
                    Can sign in · added {relativeTime(entry.createdAt)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="hover:text-danger"
                  loading={remove.isPending}
                  onClick={async () => {
                    try {
                      await remove.mutateAsync(entry.id);
                      toast("Sign-in permit removed");
                    } catch (err) {
                      toast(err instanceof ApiError ? err.hint : "Couldn't remove", "error");
                    }
                  }}
                >
                  Remove permit
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-subtle text-xs">
            No individual sign-in permits yet — sign-in follows the domain allowlist only.
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}
