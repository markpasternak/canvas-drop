import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../log/logger.js";
import { logMailer } from "./log.js";
import { mailgunMailer } from "./mailgun.js";
import { noopMailer } from "./noop.js";

const silent = { info() {}, error() {}, warn() {} } as unknown as Logger;

const mailgunCfg = (over: Record<string, unknown> = {}) =>
  ({
    driver: "mailgun" as const,
    from: "no-reply@m.example.com",
    mailgun: {
      apiKey: "key-secret",
      domain: "m.example.com",
      baseUrl: "https://api.mailgun.net",
      ...over,
    },
  }) as Parameters<typeof mailgunMailer>[0];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("noopMailer", () => {
  it("never sends and reports canSend=false", async () => {
    const m = noopMailer();
    expect(m.canSend).toBe(false);
    expect(await m.send({ to: "x@y.com", subject: "s", text: "t" })).toEqual({
      ok: false,
      error: "email_disabled",
    });
  });
});

describe("logMailer", () => {
  it("logs only the envelope (to, subject) and never the message body", async () => {
    const info = vi.fn();
    const m = logMailer({ info } as unknown as Logger);
    expect(m.canSend).toBe(true);
    const res = await m.send({ to: "g@x.com", subject: "hi", text: "private body" });
    expect(res.ok).toBe(true);
    // Envelope is logged for dev visibility…
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ to: "g@x.com", subject: "hi" }),
      expect.any(String),
    );
    // ...but message content is redacted.
    const [logged] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(logged).not.toHaveProperty("body");
    expect(JSON.stringify(logged)).not.toContain("private body");
  });
});

describe("mailgunMailer", () => {
  it("is canSend=false and refuses when unconfigured", async () => {
    const m = mailgunMailer(mailgunCfg({ apiKey: undefined }), "f@x.com", silent);
    expect(m.canSend).toBe(false);
    expect((await m.send({ to: "a@b.com", subject: "s", text: "t" })).error).toBe(
      "mailgun_not_configured",
    );
  });

  it("POSTs a form-encoded message with Basic auth to the messages endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const m = mailgunMailer(mailgunCfg(), "no-reply@m.example.com", silent);
    const res = await m.send({ to: "a@b.com", subject: "Hi", text: "body", html: "<p>body</p>" });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.mailgun.net/v3/m.example.com/messages");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("api:key-secret").toString("base64")}`,
    );
    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain("to=a%40b.com");
    expect(body).toContain("subject=Hi");
  });

  it("returns ok=false on a non-2xx response (and never logs the key)", async () => {
    const errored = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const m = mailgunMailer(mailgunCfg(), "no-reply@m.example.com", {
      error: errored,
    } as unknown as Logger);
    const res = await m.send({ to: "a@b.com", subject: "s", text: "t" });
    expect(res).toEqual({ ok: false, error: "mailgun_status_401" });
    // The logged context must not contain the API key.
    expect(JSON.stringify(errored.mock.calls)).not.toContain("key-secret");
  });

  it("returns ok=false when the transport throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const m = mailgunMailer(mailgunCfg(), "no-reply@m.example.com", silent);
    expect((await m.send({ to: "a@b.com", subject: "s", text: "t" })).error).toBe(
      "mailgun_unreachable",
    );
  });
});
