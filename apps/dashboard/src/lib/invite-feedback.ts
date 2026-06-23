import type { AddMemberStatus, EmailDelivery } from "./api.js";

type InviteFeedbackContext = "account" | "canvas" | "team";

interface InviteFeedback {
  message: string;
  tone?: "default" | "error";
}

function baseMessage(context: InviteFeedbackContext, status: AddMemberStatus): string {
  if (context === "account") {
    return status === "pending" || status === "already_pending"
      ? "Sign-in permit added"
      : "Email already permitted";
  }
  if (context === "team") {
    if (status === "pending") return "Team access pending until sign-in";
    if (status === "already_pending") return "Team access is already pending";
    if (status === "already_added") return "Already on the team";
    return "Added to the team";
  }
  if (status === "pending") return "Access pending until sign-in";
  if (status === "already_pending") return "Access is already pending";
  if (status === "already_added") return "Access already granted";
  return "Access granted";
}

export function addPersonFeedback(
  context: InviteFeedbackContext,
  status: AddMemberStatus,
  emailDelivery?: EmailDelivery,
): InviteFeedback {
  const message = baseMessage(context, status);
  if (emailDelivery?.status === "sent") return { message: `${message}. Email sent` };
  if (emailDelivery?.status === "failed") {
    return { message: `${message}. Email couldn't be sent`, tone: "error" };
  }
  return { message };
}
