import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip.js";

const TRUSTED = ["10.0.0.0/8", "127.0.0.1"];

describe("resolveClientIp", () => {
  it("returns the peer verbatim when there is no trust list", () => {
    expect(resolveClientIp("203.0.113.7", "1.2.3.4", [])).toBe("203.0.113.7");
  });

  it("returns the peer and IGNORES XFF when the peer is untrusted (anti-spoof)", () => {
    // An untrusted client cannot inject a fake client IP via X-Forwarded-For.
    expect(resolveClientIp("8.8.8.8", "1.2.3.4", TRUSTED)).toBe("8.8.8.8");
  });

  it("returns the peer when a trusted proxy forwards no XFF", () => {
    expect(resolveClientIp("127.0.0.1", undefined, TRUSTED)).toBe("127.0.0.1");
  });

  it("uses the XFF client when the peer is a trusted proxy", () => {
    expect(resolveClientIp("127.0.0.1", "203.0.113.7", TRUSTED)).toBe("203.0.113.7");
  });

  it("takes the rightmost UNTRUSTED entry, ignoring a client-forged left entry", () => {
    // Caddy appends the real peer to whatever the client sent: "<forged>, <real>".
    expect(resolveClientIp("127.0.0.1", "9.9.9.9, 203.0.113.7", TRUSTED)).toBe("203.0.113.7");
  });

  it("skips trailing trusted-proxy hops to find the real client", () => {
    expect(resolveClientIp("127.0.0.1", "203.0.113.7, 10.0.0.5", TRUSTED)).toBe("203.0.113.7");
  });

  it("falls back to the peer when every XFF entry is a trusted proxy", () => {
    expect(resolveClientIp("127.0.0.1", "10.0.0.5, 10.0.0.6", TRUSTED)).toBe("127.0.0.1");
  });

  it("handles a v4-mapped-v6 trusted peer", () => {
    expect(resolveClientIp("::ffff:10.0.0.1", "203.0.113.7", TRUSTED)).toBe("203.0.113.7");
  });

  it("returns undefined when there is no peer", () => {
    expect(resolveClientIp(undefined, "1.2.3.4", TRUSTED)).toBeUndefined();
  });

  describe("CDN client-IP header", () => {
    it("prefers the CDN header over XFF when the peer is trusted", () => {
      // e.g. True-Client-IP from Cloudflare/Fastly — a single, authoritative address.
      expect(resolveClientIp("127.0.0.1", "9.9.9.9", TRUSTED, "203.0.113.7")).toBe("203.0.113.7");
    });

    it("IGNORES the CDN header from an untrusted peer (as forgeable as XFF)", () => {
      expect(resolveClientIp("8.8.8.8", undefined, TRUSTED, "203.0.113.7")).toBe("8.8.8.8");
    });

    it("falls back to XFF when the CDN header is absent/blank", () => {
      expect(resolveClientIp("127.0.0.1", "203.0.113.7", TRUSTED, "  ")).toBe("203.0.113.7");
      expect(resolveClientIp("127.0.0.1", "203.0.113.7", TRUSTED, undefined)).toBe("203.0.113.7");
    });
  });
});
