import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";

describe("Nodemailer package compatibility", () => {
  it("keeps the envelope and message content intact without an SMTP connection", async () => {
    // The SMTP adapter tests mock Nodemailer. Its JSON transport exercises the
    // installed parser/transport without sending email or contacting a server.
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const info = await transport.sendMail({
      from: { name: "Canvas Drop", address: "no-reply@example.com" },
      to: { name: "Doe, Jane", address: "jane@example.com" },
      subject: "Access to Project notes",
      text: "You can now edit Project notes.",
      html: "<p>You can now edit <strong>Project notes</strong>.</p>",
    });

    expect(info.envelope).toEqual({
      from: "no-reply@example.com",
      to: ["jane@example.com"],
    });
    const message = JSON.parse(String(info.message));
    expect(message).toMatchObject({
      from: { name: "Canvas Drop", address: "no-reply@example.com" },
      to: [{ name: "Doe, Jane", address: "jane@example.com" }],
      subject: "Access to Project notes",
      text: "You can now edit Project notes.",
      html: "<p>You can now edit <strong>Project notes</strong>.</p>",
    });
  });
});
