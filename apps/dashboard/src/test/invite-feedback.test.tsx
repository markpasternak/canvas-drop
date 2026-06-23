import { describe, expect, it } from "vitest";
import { addPersonFeedback } from "../lib/invite-feedback.js";

describe("addPersonFeedback", () => {
  it("mentions sent email only when the server reports a sent delivery", () => {
    expect(addPersonFeedback("canvas", "granted").message).toBe("Access granted");
    expect(
      addPersonFeedback("canvas", "granted", {
        status: "skipped",
        reason: "email_disabled",
      }).message,
    ).toBe("Access granted");
    expect(addPersonFeedback("canvas", "granted", { status: "sent" }).message).toBe(
      "Access granted. Email sent",
    );
  });

  it("surfaces a partial failure without hiding the grant outcome", () => {
    expect(addPersonFeedback("team", "pending", { status: "failed" })).toEqual({
      message: "Team access pending until sign-in. Email couldn't be sent",
      tone: "error",
    });
  });
});
