import { type Config, loadConfig } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import { resolveRequest } from "./resolve-request.js";

const subdomainConfig: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvases.example.com",
});

const pathConfig: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_URL_MODE: "path",
  CANVAS_DROP_BASE_URL: "http://localhost:3000",
});

describe("resolveRequest — subdomain mode", () => {
  const r = (host: string, pathname: string) => resolveRequest({ host, pathname }, subdomainConfig);

  it("routes a canvas subdomain to canvas content with the slug", () => {
    expect(r("quiet-otter-x7k2.canvases.example.com", "/index.html")).toEqual({
      role: "canvas",
      canvasSlug: "quiet-otter-x7k2",
    });
  });

  it("routes the base host management API to dashboard", () => {
    expect(r("canvases.example.com", "/api/canvases")).toEqual({ role: "dashboard" });
  });

  it("routes the base host platform API to platform-api with the slug", () => {
    expect(r("canvases.example.com", "/v1/c/abc/kv/votes")).toEqual({
      role: "platform-api",
      canvasSlug: "abc",
    });
  });

  it("routes the base host auth path to auth", () => {
    expect(r("canvases.example.com", "/auth/login")).toEqual({ role: "auth" });
  });

  it("classifies an unexpected multi-level host safely (no throw)", () => {
    expect(r("a.b.canvases.example.com", "/index.html")).toEqual({ role: "dashboard" });
  });

  it("classifies an unrelated host as dashboard", () => {
    expect(r("evil.example.org", "/index.html")).toEqual({ role: "dashboard" });
  });
});

describe("resolveRequest — path mode", () => {
  const r = (pathname: string) => resolveRequest({ host: "localhost:3000", pathname }, pathConfig);

  it("routes /c/{slug}/... to canvas content", () => {
    expect(r("/c/abc/index.html")).toEqual({ role: "canvas", canvasSlug: "abc" });
  });

  it("routes /v1/c/{slug}/... to platform-api", () => {
    expect(r("/v1/c/abc/kv/x")).toEqual({ role: "platform-api", canvasSlug: "abc" });
  });

  it("routes /auth/... to auth and /api/... to dashboard", () => {
    expect(r("/auth/callback")).toEqual({ role: "auth" });
    expect(r("/api/canvases")).toEqual({ role: "dashboard" });
  });

  it("routes the root and unknown paths to dashboard", () => {
    expect(r("/")).toEqual({ role: "dashboard" });
    expect(r("/anything-else")).toEqual({ role: "dashboard" });
  });

  it("extracts the slug verbatim without a DB lookup", () => {
    expect(r("/c/quiet-otter-x7k2/assets/app.js")).toEqual({
      role: "canvas",
      canvasSlug: "quiet-otter-x7k2",
    });
  });
});
