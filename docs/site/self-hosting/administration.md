# Administration

Use **Admin** to investigate sharing, hand over work when someone leaves, and manage
the lifecycle of canvases across your instance. These screens require an administrator
account. Administrative visibility covers metadata; it does not grant access to a
canvas's private content or saved app data.

## Find the right canvases

Open **Admin → Canvases**. Filters combine with **AND** and apply to the complete
dataset before counts and pagination. Boolean filters offer **Any**, **Yes**, and **No**.

| Find | Choose |
| --- | --- |
| Public canvases without a password | Effective public link: Yes; Password: No |
| Public canvases that have not expired | Effective public link: Yes; Expiry: Not expired |
| External access without a password | External people: Yes; Password: No |
| Configured public links that are currently unavailable | Configured access: Public link; Effective public link: No |
| Deleted canvases ready for a retention review | Purge state: Retention elapsed |
| Interrupted cleanup to retry | Purge state: Cleanup incomplete |

**Configured access** is the stored sharing choice. **Effective public link** also checks the
canvas's active state, published version, expiry, and owner/instance public-publishing
permission. A password remains a separate filter. **Not expired** includes canvases
with no expiry. External and pending access counts include the relevant people,
team grants, and unconsumed invitations; an invitation alone does not grant access.

Remove individual conditions from their summaries or reset the view. The URL preserves
filters, sorting, and page. **Save view** stores up to 20 named filter/sort combinations
for your account in this browser. **Table display** controls optional columns and row
density. Saved views and display preferences do not sync between browsers.

![The admin table combining effective public access with no password, using a locally published example guide.](/docs/assets/tour-admin.webp)

## Investigate access without opening private content

Select a canvas title to open its inspector alongside the list. Your filters and
position remain available. Review ownership, lifecycle, configured and effective
access, aggregate usage, Connection grants, and recent administrative activity.

Enter a person's email in the access explanation to check their current account,
ownership/editor role, direct grants, teams, live organization membership, and pending
invitations. The explanation also checks sign-in email policy and blocked accounts,
and identifies lifecycle, expiry, and password gates.
An anonymous check explains public access, which serves static content only. This
does not impersonate the person, test their password, or fetch private canvas files.

**Admin → Activity** searches recorded administrative events by text, actor, canvas,
action, and date. It shows recorded reasons and selected safe details. It does not
expose credentials, request bodies, or arbitrary raw audit metadata, and is not a
complete log of every authentication or runtime event.

## Offboard a person

1. In **Admin → People**, open the person's actions and choose **Offboard person**.
2. Review owned canvases, current access, team memberships, invitations, and individual
   sign-in permission. Choose an eligible successor for ownership handover.
3. Review any unresolved canvases or team administration. Add a reason and type the
   displayed confirmation.
4. Read the per-step results. Resolve outstanding items and refresh the preview before
   retrying an interrupted operation.

For an existing account, offboarding blocks sign-in, removes administrator and public
publishing privileges, revokes app sessions and MCP access/refresh tokens, and removes
the listed grants, memberships, invitations, and individual sign-in permission.
Transfers use the same ownership rules as ordinary admin reassignment, rotate deploy
keys, and preserve canvas content. The departing person does not retain editor access.
Remaining owner deploy keys are revoked. Untransferred public canvases become Restricted;
transferred canvases follow the successor's public-publishing permission.

You cannot offboard yourself or remove the last usable administrator. Changed previews
must be reviewed again. The result explicitly reports failed steps and remaining
ownership/access. Team creator attribution needs separate administrative review.
Membership or sessions held by your identity provider are not removed; the local block
prevents account access until an admin unblocks it. Public content can still be viewed
while signed out. For an email with no account, this removes current permissions and
invitations; it does not create a permanent email ban.

## Delete, restore, and permanently purge

Select individual canvases or use the selection boxes for a bulk operation. Selection
covers the displayed items you explicitly choose, with a maximum of 50 per request.
Changing filters or page clears selection. The impact preview identifies ineligible
items; confirmation applies only to the eligible items shown. Every item gets a result.

**Delete** takes a canvas offline and retains its files. **Restore** returns it to
active status with its existing sharing rules, until permanent cleanup starts.
**Permanently purge** removes actual deployed and draft files, previews, uploads,
saved app data, versions, invitations, and access grants. It retains the canvas's
identity and audit history. Content-addressed files are scoped to each canvas, so
purging one canvas does not delete another canvas's files.

The admin UI requires 30 days after deletion and refuses recent in-progress deployments.
Its preview shows version/file/app-data counts and the actual storage files to remove.
Add a reason and type the exact confirmation. Once cleanup starts, the canvas cannot
be restored through the app. If cleanup fails, find it under **Cleanup incomplete**,
review a fresh preview, and retry the remaining cleanup.

**Backups are separate.** Purge does not erase old backup archives or storage-provider
version history. Follow your backup retention policy. The operator's maintenance CLI
can use a different deletion age; the 30-day admin UI window does not override it.
See the repository's [operations runbook](https://github.com/markpasternak/canvas-drop/blob/main/docs/ops.md).

## Operate Connections

**Admin → Connections** shows observed success/failure counts, average latency, last
success and failure, and affected canvases for the last 24 hours. **No recent traffic**
means there is no observation in that window, not proof that the upstream is healthy.
Recent outcomes name the canvases and link to their metadata inspector.

Under **Manage**, a diagnostic sends a HEAD request to a path on the configured HTTPS
origin using its protected headers and existing outbound restrictions. The profile
must be enabled and allow HEAD. The request has a five-second limit, a 32 KB response
ceiling, no redirects, and a ten-second cooldown. Only status and timing are displayed;
response content is discarded, and paths/queries are not recorded in activity. Probes
do not count as canvas traffic or verify a canvas's permissions.

To rotate credentials, create a replacement at the upstream, review the granted
canvases, and replace the complete protected-header set. Include headers you want to
keep: an empty set clears all of them. Verify a suitable endpoint and a granted canvas's
real workflow, then revoke the old credential at the upstream. A successful HEAD
request alone may not prove authentication. Protected values cannot be read back.

## Use the overview

**Needs attention** flags incomplete cleanup, observed Connection failures, and
unavailable Connection credentials. Every signal links to a relevant action.
**Routine reviews** separates intentional public sharing, disabled canvases, and
elapsed retention from operational exceptions. Normal usage and AI spending remain
in their existing overview sections.

Cross-owner admin operations use dedicated administrator routes. They are intentionally
outside the per-account MCP tool surface; ordinary owner/editor tools keep their existing
role checks.
