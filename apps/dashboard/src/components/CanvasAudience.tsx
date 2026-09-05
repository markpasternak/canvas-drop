import { LockKey, UsersThree } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Canvas } from "../lib/api.js";
import { fullTime } from "../lib/format.js";

export type AudienceCanvas = Pick<
  Canvas,
  | "id"
  | "access"
  | "status"
  | "currentVersionId"
  | "sharedExpiresAt"
  | "hasPassword"
  | "publicLinkEnabled"
  | "orgId"
>;

/** Keep the expiry sentence current even while the reader leaves this view open. */
function useExpired(expiresAt: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (expiresAt === null || expiresAt <= Math.max(now, Date.now())) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(expiresAt - Date.now() + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, now]);
  return expiresAt !== null && expiresAt <= Date.now();
}

/** Describes access without inferring an empty people list from missing/loading data.
 * Pending invitations are never counted as grants. This is explanatory UI, not a gate. */
export function CanvasAudience({
  canvas,
  orgs,
  isGuest,
  afterPublish = false,
}: {
  canvas: AudienceCanvas;
  orgs?: Array<{ id: string; name: string }>;
  isGuest?: boolean;
  /** Explain the prospective audience in publish review; omit the navigation away. */
  afterPublish?: boolean;
}) {
  const expired = useExpired(canvas.sharedExpiresAt);
  const orgName = orgs?.find((org) => org.id === canvas.orgId)?.name;
  const orgAccessEnabled =
    canvas.orgId !== null || (orgs !== undefined && orgs.length === 0 && !isGuest);
  const live = canvas.status === "active" && (!!canvas.currentVersionId || afterPublish);
  let audience: string;
  if (canvas.status !== "active") {
    audience = `${canvas.status === "archived" ? "Archived" : canvas.status === "deleted" ? "Deleted" : "Disabled"} — this link is offline.`;
  } else if (!canvas.currentVersionId && !afterPublish) {
    audience = "Publish this draft before sharing its link.";
  } else if (expired) {
    audience = "Viewer access has expired. Owners and editors can still open.";
  } else if (canvas.access === "public_link") {
    audience =
      canvas.publicLinkEnabled === true
        ? "Anyone with the link"
        : canvas.publicLinkEnabled === false
          ? "Public sharing is paused; direct access still applies."
          : "Public link selected; availability hasn't been verified.";
  } else if (canvas.access === "whole_org" && canvas.orgId === null && orgs === undefined) {
    audience = "Organization access selected; availability hasn't been verified.";
  } else if (canvas.access === "whole_org" && orgAccessEnabled) {
    audience = `${orgName ?? "Workspace"} members, plus people and teams with access`;
  } else {
    audience = "Restricted to people and teams with access";
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs leading-relaxed text-muted">
      <p aria-live="polite">{audience}</p>
      {live && canvas.hasPassword && (
        <span className="inline-flex items-center gap-1">
          <LockKey size={13} aria-hidden /> Password protection on
        </span>
      )}
      {live && canvas.sharedExpiresAt !== null && (
        <span>
          {expired ? "Expired" : "Viewer access expires"}{" "}
          <time dateTime={new Date(canvas.sharedExpiresAt).toISOString()}>
            {fullTime(canvas.sharedExpiresAt)}
          </time>
        </span>
      )}
      {live && !afterPublish && (
        <Link
          to="/canvases/$id/share"
          params={{ id: canvas.id }}
          hash="people"
          className="inline-flex items-center gap-1.5 rounded-md py-1 font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <UsersThree size={14} aria-hidden /> People and teams
        </Link>
      )}
    </div>
  );
}
