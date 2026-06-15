import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../log/logger.js";

const sendMail = vi.fn(async () => ({}));
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock("nodemailer", () => ({ default: { createTransport }, createTransport }));

const { smtpMailer } = await import("./smtp.js");

const silent = { info() {}, error() {}, warn() {} } as unknown as Logger;

const cfg = (over: Record<string, unknown> = {}) =>
  ({
    driver: "smtp",
    from: "no-reply@x.com",
    smtp: { host: "smtp.example.com", port: 587, user: "u", pass: "p", secure: false, ...over },
    mailgun: { apiKey: undefined, domain: undefined, baseUrl: "https://api.mailgun.net" },
  }) as unknown as Parameters<typeof smtpMailer>[0];

afterEach(() => {
  sendMail.mockClear();
  createTransport.mockClear();
});

describe("smtpMailer", () => {
  it("is canSend=false and refuses when no host is set", async () => {
    const m = smtpMailer(cfg({ host: undefined }), "f@x.com", silent);
    expect(m.canSend).toBe(false);
    expect((await m.send({ to: "a@b.com", subject: "s", text: "t" })).error).toBe(
      "smtp_not_configured",
    );
  });

  it("sends via nodemailer when configured", async () => {
    const m = smtpMailer(cfg(), "no-reply@x.com", silent);
    expect(m.canSend).toBe(true);
    const res = await m.send({ to: "a@b.com", subject: "Hi", text: "body", html: "<p>body</p>" });
    expect(res.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@b.com", from: "no-reply@x.com", subject: "Hi" }),
    );
  });

  it("omits auth when no user/pass (IP-allowlisted relay)", async () => {
    const m = smtpMailer(cfg({ user: undefined, pass: undefined }), "f@x.com", silent);
    await m.send({ to: "a@b.com", subject: "s", text: "t" });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: undefined }));
  });

  it("returns ok=false when the transport throws", async () => {
    sendMail.mockRejectedValueOnce(new Error("boom"));
    const m = smtpMailer(cfg(), "f@x.com", silent);
    expect((await m.send({ to: "a@b.com", subject: "s", text: "t" })).error).toBe(
      "smtp_send_failed",
    );
  });

  it("bounds the transport with explicit timeouts (no indefinite hang)", async () => {
    const m = smtpMailer(cfg(), "no-reply@x.com", silent);
    await m.send({ to: "a@b.com", subject: "s", text: "t" });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: expect.any(Number),
        socketTimeout: expect.any(Number),
        greetingTimeout: expect.any(Number),
      }),
    );
  });

  it("never logs the SMTP password on a send failure", async () => {
    const errored = vi.fn();
    const log = { info() {}, error: errored, warn() {} } as unknown as Logger;
    sendMail.mockRejectedValueOnce(new Error("connection refused"));
    const m = smtpMailer(cfg({ pass: "s3cr3t-smtp-pass" }), "no-reply@x.com", log);
    await m.send({ to: "a@b.com", subject: "s", text: "t" });
    expect(errored).toHaveBeenCalled();
    expect(JSON.stringify(errored.mock.calls)).not.toContain("s3cr3t-smtp-pass");
  });
});
