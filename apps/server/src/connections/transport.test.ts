import { describe, expect, it, vi } from "vitest";
import {
  buildConnectionTarget,
  isPublicAddress,
  normalizeConnectionOrigin,
} from "./address-policy.js";
import {
  buildPinnedRequestOptions,
  connectionTransport,
  type RawConnectionResponse,
} from "./transport.js";

const PUBLIC_ADDRESSES = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"];

const BLOCKED_ADDRESSES = [
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.0.1",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "100::1",
  "2001:db8::1",
  "fc00::1",
  "fe80::1",
  "ff02::1",
];

describe("connection address policy", () => {
  it.each(PUBLIC_ADDRESSES)("accepts globally routable address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(BLOCKED_ADDRESSES)("rejects special-purpose address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("normalizes an exact HTTPS origin and rejects authority expansion", () => {
    expect(normalizeConnectionOrigin("https://API.Example.com:8443")).toBe(
      "https://api.example.com:8443",
    );
    expect(() => normalizeConnectionOrigin("http://api.example.com")).toThrow("HTTPS");
    expect(() => normalizeConnectionOrigin("https://user:pass@api.example.com")).toThrow(
      "credentials",
    );
    expect(() => normalizeConnectionOrigin("https://api.example.com/v1")).toThrow("origin");
    expect(() => normalizeConnectionOrigin("https://127.0.0.1")).toThrow("hostname");
  });

  it("keeps canvas paths on the approved origin", () => {
    expect(buildConnectionTarget("https://api.example.com", "/quotes?symbol=CDROP").href).toBe(
      "https://api.example.com/quotes?symbol=CDROP",
    );
    expect(() =>
      buildConnectionTarget("https://api.example.com", "https://evil.example/x"),
    ).toThrow("relative");
    expect(() => buildConnectionTarget("https://api.example.com", "//evil.example/x")).toThrow(
      "relative",
    );
    expect(() => buildConnectionTarget("https://api.example.com", "/ok\r\nInjected: yes")).toThrow(
      "control",
    );
  });
});

function rawResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): RawConnectionResponse {
  let destroyed = false;
  return {
    status,
    headers: new Headers(headers),
    body: (async function* () {
      yield new TextEncoder().encode(body);
    })(),
    destroy: () => {
      destroyed = true;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

describe("connection transport", () => {
  it("pins the validated address while retaining the TLS hostname", async () => {
    const options = buildPinnedRequestOptions({
      url: new URL("https://api.example.com:8443/quotes?symbol=CDROP"),
      method: "GET",
      headers: new Headers({ accept: "application/json" }),
      address: { address: "8.8.8.8", family: 4 },
      signal: new AbortController().signal,
    });

    expect(options.hostname).toBe("api.example.com");
    expect(options.servername).toBe("api.example.com");
    expect(options.port).toBe(8443);
    expect(options.path).toBe("/quotes?symbol=CDROP");

    const lookup = options.lookup as NonNullable<typeof options.lookup>;
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("changed.example", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family: Number(family) });
      });
    });
    expect(result).toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("forwards bounded data with fixed headers applied last", async () => {
    const request = vi.fn(async (input) => {
      expect(input.address).toEqual({ address: "8.8.8.8", family: 4 });
      expect(input.headers.get("user-agent")).toBe("Canvas-Drop-Stock/1");
      expect(input.headers.get("accept-encoding")).toBe("identity");
      expect(input.headers.has("cookie")).toBe(false);
      return rawResponse(200, '{"price":123}', {
        "content-type": "application/json",
        "set-cookie": "secret=upstream",
        server: "private",
      });
    });
    const transport = connectionTransport({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      request,
    });

    const result = await transport.fetch({
      origin: "https://api.example.com",
      path: "/quotes?symbol=CDROP",
      method: "GET",
      allowedMethods: ["GET"],
      callerHeaders: [
        ["accept", "application/json"],
        ["cookie", "canvas-session"],
      ],
      protectedHeaders: [["User-Agent", "Canvas-Drop-Stock/1"]],
      maxResponseBytes: 1024,
      timeoutMs: 1_000,
      maxRedirects: 3,
    });

    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe('{"price":123}');
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(result.headers.has("set-cookie")).toBe(false);
    expect(result.headers.has("server")).toBe(false);
  });

  it("rejects a mixed public/private DNS answer before socket creation", async () => {
    const request = vi.fn();
    const transport = connectionTransport({
      resolve: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      request,
    });

    await expect(
      transport.fetch({
        origin: "https://api.example.com",
        path: "/quotes",
        method: "GET",
        allowedMethods: ["GET"],
        callerHeaders: [],
        protectedHeaders: [],
        maxResponseBytes: 1024,
        timeoutMs: 1_000,
        maxRedirects: 3,
      }),
    ).rejects.toMatchObject({ code: "DESTINATION_BLOCKED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("revalidates redirects and refuses a rewritten unapproved method", async () => {
    const first = rawResponse(303, "", { location: "/result" });
    const request = vi.fn(async () => first);
    const transport = connectionTransport({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      request,
    });

    await expect(
      transport.fetch({
        origin: "https://api.example.com",
        path: "/submit",
        method: "POST",
        allowedMethods: ["POST"],
        callerHeaders: [],
        protectedHeaders: [],
        body: new TextEncoder().encode("x=1"),
        maxResponseBytes: 1024,
        timeoutMs: 1_000,
        maxRedirects: 3,
      }),
    ).rejects.toMatchObject({ code: "METHOD_NOT_ALLOWED" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(first.destroyed).toBe(true);
  });

  it("refuses cross-origin redirects and oversized or encoded responses", async () => {
    const cases: Array<{ response: RawConnectionResponse; code: string }> = [
      {
        response: rawResponse(302, "", { location: "https://evil.example/steal" }),
        code: "DESTINATION_BLOCKED",
      },
      {
        response: rawResponse(200, "compressed", { "content-encoding": "gzip" }),
        code: "UPSTREAM_UNAVAILABLE",
      },
      { response: rawResponse(200, "too large"), code: "RESPONSE_TOO_LARGE" },
    ];

    for (const testCase of cases) {
      const transport = connectionTransport({
        resolve: async () => [{ address: "8.8.8.8", family: 4 }],
        request: async () => testCase.response,
      });
      await expect(
        transport.fetch({
          origin: "https://api.example.com",
          path: "/quotes",
          method: "GET",
          allowedMethods: ["GET"],
          callerHeaders: [],
          protectedHeaders: [],
          maxResponseBytes: 4,
          timeoutMs: 1_000,
          maxRedirects: 3,
        }),
      ).rejects.toMatchObject({ code: testCase.code });
      expect(testCase.response.destroyed).toBe(true);
    }
  });

  it("applies the total deadline while DNS is still pending", async () => {
    const request = vi.fn();
    const transport = connectionTransport({
      resolve: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([{ address: "8.8.8.8", family: 4 }]), 100),
        ),
      request,
    });

    await expect(
      transport.fetch({
        origin: "https://api.example.com",
        path: "/quotes",
        method: "GET",
        allowedMethods: ["GET"],
        callerHeaders: [],
        protectedHeaders: [],
        maxResponseBytes: 1024,
        timeoutMs: 10,
        maxRedirects: 3,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(request).not.toHaveBeenCalled();
  });
});
