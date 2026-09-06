import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type AdminOffboardingResults, ApiError, api } from "../lib/api.js";
import { useAdminUsers } from "../lib/queries.js";
import { Badge } from "./Badge.js";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { Field, TextareaField } from "./Field.js";

export function AdminOffboardingDialog({
  email,
  meId,
  onClose,
}: {
  email: string;
  meId?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [successor, setSuccessor] = useState<{ id: string; email: string } | null>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [results, setResults] = useState<AdminOffboardingResults | null>(null);
  const qc = useQueryClient();
  const users = useAdminUsers({ q: query, limit: 8 });
  const preview = useQuery({
    queryKey: ["admin", "offboarding", email, successor?.id],
    queryFn: () => api.admin.previewOffboarding(email, successor?.id),
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const execute = useMutation({ mutationFn: api.admin.executeOffboarding });
  const data = preview.data;
  const hasUnresolved =
    data && (data.owned.some((canvas) => !canvas.transferEligible) || data.createdTeams.length > 0);
  const phrase = `OFFBOARD ${email}`;
  return (
    <Dialog
      placement="side"
      open
      onClose={onClose}
      dismissable={!execute.isPending}
      title={`Offboard ${email}`}
    >
      <div className="space-y-5">
        <p className="text-sm text-muted">
          Review the impact, choose a successor where appropriate, then confirm. Canvas content is
          retained.
        </p>
        {preview.isLoading && <p role="status">Loading access and ownership…</p>}
        {preview.isError && (
          <p role="alert">
            Could not prepare offboarding.{" "}
            <Button variant="ghost" onClick={() => preview.refetch()}>
              Retry preview
            </Button>
          </p>
        )}
        {data && !results && (
          <>
            <section className="space-y-2" aria-label="Account impact">
              <h3 className="font-semibold">Account and sign-in</h3>
              <p className="text-sm text-muted">
                {data.user
                  ? "Block the account, remove admin and public-publishing privileges, revoke sign-in sessions and agent tokens, and rotate any remaining owner deploy keys."
                  : "This email has no account. Remove its current invitations and individual sign-in permission. This does not create an account or a permanent email ban."}
              </p>
              {data.organizations.length > 0 && (
                <p className="text-sm text-muted">
                  Organization membership: {data.organizations.map((org) => org.name).join(", ")}.
                  Identity-provider membership is unchanged; the local account block prevents
                  sign-in until an admin unblocks it.
                </p>
              )}
              <p className="text-xs text-subtle">
                Public content may still be viewed while signed out. Untransferred public canvases
                become restricted. Successfully transferred canvases follow the successor's
                public-publishing permission.
              </p>
              {data.self && (
                <p role="alert" className="text-danger">
                  You cannot offboard yourself.
                </p>
              )}
            </section>
            {data.owned.length > 0 && (
              <section className="space-y-3" aria-label="Ownership handover">
                <h3 className="font-semibold">{data.owned.length} owned canvases</h3>
                <Field
                  label="Successor"
                  placeholder="Search accounts by name or email"
                  value={successor?.email ?? query}
                  onChange={(event) => {
                    setSuccessor(null);
                    setQuery(event.target.value);
                    setAcknowledge(false);
                    setConfirmation("");
                  }}
                />
                {!successor && query.length >= 2 && (
                  <div className="space-y-1 rounded-lg border border-border p-2">
                    {users.isError && <p role="alert">Could not search accounts.</p>}
                    {(users.data?.users ?? [])
                      .filter(
                        (user) => !user.isBlocked && user.id !== meId && user.id !== data.user?.id,
                      )
                      .map((user) => (
                        <Button
                          key={user.id}
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSuccessor({ id: user.id, email: user.email });
                            setQuery("");
                            setAcknowledge(false);
                            setConfirmation("");
                          }}
                        >
                          {user.name} · {user.email}
                        </Button>
                      ))}
                    {users.data &&
                      !users.data.users.some(
                        (user) => !user.isBlocked && user.id !== meId && user.id !== data.user?.id,
                      ) && (
                        <p className="text-sm text-muted">
                          No eligible account in these search results.
                        </p>
                      )}
                  </div>
                )}
                {successor && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSuccessor(null);
                      setAcknowledge(false);
                      setConfirmation("");
                    }}
                  >
                    Clear successor
                  </Button>
                )}
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {data.owned.map((canvas) => (
                    <li key={canvas.id} className="space-y-1 p-3 text-sm">
                      <p className="font-medium">
                        {canvas.title || canvas.slug}{" "}
                        <span className="text-xs text-subtle">({canvas.status})</span>
                      </p>
                      <p className="text-muted">
                        {canvas.transferEligible
                          ? `Transfer to ${data.recipient?.email}`
                          : canvas.transferExplanation}
                      </p>
                      {canvas.publicLinkReverted && (
                        <p className="text-xs text-muted">The public link becomes restricted.</p>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-subtle">
                  The departing person does not retain editor access. Existing ownership
                  notifications apply where enabled.
                </p>
              </section>
            )}
            <section className="space-y-2" aria-label="Access removal">
              <h3 className="font-semibold">Access to remove</h3>
              <ul className="space-y-1 text-sm text-muted">
                {data.direct.map((grant) => (
                  <li key={grant.id}>
                    Direct {grant.role}: {grant.title || grant.canvasId}
                  </li>
                ))}
                {data.memberships.map((team) => (
                  <li key={team.id}>Team membership: {team.name}</li>
                ))}
                {data.pending.map((invite) => (
                  <li key={invite.id}>
                    Pending {invite.targetType} invitation · {invite.targetId}
                  </li>
                ))}
                {data.permits.length > 0 && <li>Individual sign-in permission for {email}</li>}
                {!data.direct.length &&
                  !data.memberships.length &&
                  !data.pending.length &&
                  !data.permits.length && <li>No additional grants or pending invitations.</li>}
              </ul>
            </section>
            {data.createdTeams.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-semibold">Team administration to review</h3>
                <p className="text-sm text-muted">
                  These teams remain attributed to this creator. Review who will administer them;
                  their other members and canvas grants are preserved.
                </p>
                <ul className="list-disc pl-4 text-sm text-muted">
                  {data.createdTeams.map((team) => (
                    <li key={team.id}>{team.name}</li>
                  ))}
                </ul>
              </section>
            )}
            {hasUnresolved && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledge}
                  onChange={(event) => setAcknowledge(event.target.checked)}
                />
                Continue with the unresolved ownership or team administration shown above
              </label>
            )}
            <TextareaField
              label="Offboarding reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              maxLength={500}
            />
            <Field
              label={`Type ${phrase} to confirm`}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
            />
            {execute.isError && (
              <p role="alert" className="text-danger">
                {execute.error instanceof ApiError
                  ? execute.error.hint
                  : "Offboarding may be incomplete. Refresh the preview before retrying."}
              </p>
            )}
            <Button
              variant="danger"
              loading={execute.isPending}
              disabled={
                data.self ||
                preview.isFetching ||
                execute.isError ||
                !reason.trim() ||
                confirmation !== phrase ||
                (!!hasUnresolved && !acknowledge)
              }
              onClick={async () => {
                try {
                  setResults(
                    await execute.mutateAsync({
                      email,
                      toUserId: successor?.id,
                      fingerprint: data.fingerprint,
                      reason: reason.trim(),
                      confirmation,
                    }),
                  );
                  void qc.invalidateQueries({ queryKey: ["admin"] });
                } catch {
                  /* A fresh preview is required after a failed or uncertain request. */
                }
              }}
            >
              Confirm offboarding
            </Button>
          </>
        )}
        {results && (
          <section aria-label="Offboarding results" className="space-y-3">
            <Badge tone={results.complete ? "success" : "warning"}>
              {results.complete ? "Offboarding complete" : "Offboarding needs follow-up"}
            </Badge>
            <p className="text-sm">
              {results.accountBlocked === true
                ? "The account is blocked."
                : results.accountBlocked === null
                  ? "This email has no account."
                  : "The account is still active."}
            </p>
            <ul className="space-y-2 text-sm">
              {results.outcomes.map((item) => (
                <li key={`${item.kind}:${item.id}`}>
                  <strong>{item.label}</strong>: {item.message}
                </li>
              ))}
            </ul>
            {results.unresolved.length > 0 && (
              <div>
                <h3 className="font-semibold">Unresolved</h3>
                <ul className="list-disc space-y-1 pl-4 text-sm">
                  {results.unresolved.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
        {(results || execute.isError) && (
          <Button
            variant="secondary"
            onClick={async () => {
              setResults(null);
              setConfirmation("");
              setAcknowledge(false);
              execute.reset();
              await preview.refetch();
            }}
          >
            Review a fresh preview
          </Button>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose} disabled={execute.isPending}>
            {results ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
