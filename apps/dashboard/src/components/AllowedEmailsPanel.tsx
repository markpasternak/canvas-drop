import { useState } from "react";
import { ApiError } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";
import { useAddAllowedEmail, useRemoveAllowedEmail } from "../lib/mutations.js";
import { useAdminAllowedEmails } from "../lib/queries.js";
import { Button } from "./Button.js";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { useToast } from "./Toast.js";

/**
 * Admin individual sign-in allowlist (D14 supplement). Lets an admin allow specific
 * outside emails to sign in even when their domain isn't in the env domain allowlist
 * (CANVAS_DROP_ALLOWED_EMAIL_DOMAINS, which is unchanged). Add-by-email + remove,
 * modeled on the canvas guest-invite UI.
 */
export function AllowedEmailsPanel() {
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
      await add.mutateAsync(value);
      setEmail("");
      toast("Email allowed");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't add email", "error");
    }
  }

  const count = emails?.length ?? 0;

  return (
    <CollapsibleSection
      title={`Allowed sign-in emails${count > 0 ? ` (${count})` : ""}`}
      storageKey="admin:section:allowed-emails"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <p className="text-muted text-xs">
          Individual emails that may sign in even when their domain isn't in the configured
          email-domain allowlist. The domain allowlist is set by the operator in the environment;
          this is an additive list you manage here.
        </p>

        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1">
            <label htmlFor="allowed-email" className="font-medium text-subtle text-xs">
              Add by email
            </label>
            <input
              id="allowed-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              className="mt-1 h-9 w-full rounded-lg border border-border bg-surface px-3 text-fg text-sm placeholder:text-subtle focus:border-border-strong focus:outline-none"
            />
          </div>
          <Button type="submit" size="sm" variant="secondary" loading={add.isPending}>
            Add
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
                  <div className="text-subtle text-xs">added {relativeTime(entry.createdAt)}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="hover:text-danger"
                  loading={remove.isPending}
                  onClick={async () => {
                    try {
                      await remove.mutateAsync(entry.id);
                      toast("Email removed");
                    } catch (err) {
                      toast(err instanceof ApiError ? err.hint : "Couldn't remove", "error");
                    }
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-subtle text-xs">
            No individual emails yet — sign-in follows the domain allowlist only.
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}
