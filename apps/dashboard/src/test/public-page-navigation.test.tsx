import { runInNewContext } from "node:vm";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAV_CLIENT_JS } from "../../../server/src/docs/nav.client.js";
import { SEARCH_CLIENT_JS } from "../../../server/src/docs/search.client.js";
import { THEME_CLIENT_JS } from "../../../server/src/docs/theme.client.js";

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.className = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("public-page browser controls", () => {
  it("copies the original command text and exposes clipboard failure", async () => {
    document.body.innerHTML =
      '<article class="doc"><pre><code>pnpm install\npnpm dev</code></pre><pre class="mermaid">graph TD</pre></article>';
    const writeText = vi.fn().mockResolvedValue(undefined);
    runInNewContext(NAV_CLIENT_JS, { document, navigator: { clipboard: { writeText } } });
    const button = document.querySelector("button") as HTMLButtonElement;
    expect(document.querySelectorAll("button")).toHaveLength(1);
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent("Copied"));
    expect(writeText).toHaveBeenCalledWith("pnpm install\npnpm dev");
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent("Copy failed"));
  });
  it("ranks all pages before limiting and supports arrow-key result navigation", async () => {
    document.body.innerHTML =
      '<div class="search"><input id="docs-search"><div id="docs-search-results"></div></div>';
    const entries = Array.from({ length: 15 }, (_, i) => ({
      path: `body-${i}`,
      title: `Body ${i}`,
      headings: [] as string[],
      text: "Learn about MCP here",
    }));
    entries.push(
      { path: "heading", title: "Integrations", headings: ["MCP setup"], text: "Connect an agent" },
      { path: "title", title: "MCP server guide", headings: [], text: "Connect an agent" },
      { path: "exact", title: "MCP", headings: [], text: "Connect an agent" },
    );
    runInNewContext(SEARCH_CLIENT_JS, {
      document,
      fetch: async () => ({ ok: true, json: async () => entries }),
    });
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    fireEvent.input(input, { target: { value: "MCP" } });
    await waitFor(() =>
      expect(document.querySelectorAll("#docs-search-results a")).toHaveLength(12),
    );
    const links = document.querySelectorAll<HTMLAnchorElement>("#docs-search-results a");
    expect(
      Array.from(links)
        .slice(0, 3)
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/docs/exact", "/docs/title", "/docs/heading"]);
    expect(document.querySelector('[role="status"]')).toHaveTextContent(
      "18 pages; showing the 12 best matches",
    );
    expect(links[2]).toHaveTextContent("MCP setup");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(links[0] as HTMLAnchorElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(links[11]);
  });

  it("announces loading and retries a failed index without reloading the page", async () => {
    document.body.innerHTML =
      '<div class="search"><input id="docs-search"><div id="docs-search-results"></div></div>';
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        ok: true,
        json: async () => [
          { path: "sdk/kv", title: "Storage", headings: [], text: "Store values" },
        ],
      });
    runInNewContext(SEARCH_CLIENT_JS, { document, fetch });
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    fireEvent.input(input, { target: { value: "storage" } });
    expect(document.querySelector('[role="status"]')).toHaveTextContent("Searching documentation");
    await waitFor(() => expect(document.querySelector("[data-search-retry]")).not.toBeNull());
    expect(document.querySelector('[role="alert"]')).toHaveTextContent("Search unavailable");
    fireEvent.click(document.querySelector("[data-search-retry]") as HTMLButtonElement);
    await waitFor(() =>
      expect(document.querySelector("#docs-search-results a")).toHaveTextContent("Storage"),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("collapses mobile navigation, restores focus on Escape and opens on desktop", () => {
    document.body.innerHTML =
      '<details id="docs-navigation" open><summary>Browse documentation</summary><a href="/docs">Overview</a></details>';
    const media = new EventTarget() as EventTarget & { matches: boolean };
    media.matches = true;
    runInNewContext(NAV_CLIENT_JS, { document, matchMedia: () => media });
    const menu = document.querySelector("details") as HTMLDetailsElement;
    expect(menu.open).toBe(false);
    menu.open = true;
    const link = document.querySelector("a") as HTMLAnchorElement;
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("summary"));
    media.matches = false;
    media.dispatchEvent(new Event("change"));
    expect(menu.open).toBe(true);
    fireEvent.keyDown(link, { key: "Escape" });
    expect(menu.open).toBe(true);
  });

  it("keeps search results available while tabbing into them and clears on leaving", async () => {
    document.body.innerHTML =
      '<div class="search"><input id="docs-search"><div id="docs-search-results"></div></div><button>Outside</button>';
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { path: "sdk/kv", title: "Key-value storage", headings: [], text: "Store values" },
      ],
    });
    runInNewContext(SEARCH_CLIENT_JS, { document, fetch });
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    fireEvent.input(input, { target: { value: "Store" } });
    await waitFor(() => expect(document.querySelector("#docs-search-results a")).not.toBeNull());
    const link = document.querySelector("#docs-search-results a") as HTMLAnchorElement;
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(link.isConnected).toBe(true);
    (document.querySelector("button") as HTMLButtonElement).focus();
    expect(document.querySelector("#docs-search-results")?.childElementCount).toBe(0);
  });

  it("preserves pointer activation when Safari blurs the search input without focusing the link", async () => {
    document.body.innerHTML =
      '<div class="search"><input id="docs-search"><div id="docs-search-results"></div></div><button>Outside</button>';
    runInNewContext(SEARCH_CLIENT_JS, {
      document,
      fetch: async () => ({
        ok: true,
        json: async () => [
          { path: "sdk/kv", title: "Key-value storage", headings: [], text: "Store values" },
        ],
      }),
    });
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    fireEvent.input(input, { target: { value: "Store" } });
    await waitFor(() => expect(document.querySelector("#docs-search-results a")).not.toBeNull());
    const link = document.querySelector("#docs-search-results a") as HTMLAnchorElement;
    const activate = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener("click", activate);
    fireEvent.pointerDown(link);
    input.blur();
    expect(link.isConnected).toBe(true);
    fireEvent.click(link);
    expect(activate).toHaveBeenCalledOnce();
    fireEvent.pointerDown(document.querySelector("button") as HTMLButtonElement);
    expect(document.querySelector("#docs-search-results")?.childElementCount).toBe(0);
  });

  it("dismisses search with Escape before dismissing its containing menu", async () => {
    document.body.innerHTML =
      '<details id="docs-navigation" open><summary>Browse documentation</summary><div class="search"><input id="docs-search"><div id="docs-search-results"></div></div></details>';
    const media = new EventTarget() as EventTarget & { matches: boolean };
    media.matches = true;
    runInNewContext(NAV_CLIENT_JS, { document, matchMedia: () => media });
    const menu = document.querySelector("details") as HTMLDetailsElement;
    menu.open = true;
    runInNewContext(SEARCH_CLIENT_JS, { document, fetch: vi.fn() });
    const input = document.querySelector("input") as HTMLInputElement;
    (document.querySelector("#docs-search-results") as HTMLDivElement).innerHTML =
      '<a href="/docs">Overview</a>';
    fireEvent.keyDown(input, { key: "Escape" });
    expect(menu.open).toBe(true);
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("summary"));
  });

  it.each(["blur", "Escape"])(
    "does not reopen dismissed search after a delayed response (%s)",
    async (dismissal) => {
      document.body.innerHTML =
        '<div class="search"><input id="docs-search"><div id="docs-search-results"></div></div><button>Outside</button>';
      let resolveResponse: (value: unknown) => void = () => {};
      const response = new Promise((resolve) => {
        resolveResponse = resolve;
      });
      runInNewContext(SEARCH_CLIENT_JS, { document, fetch: () => response });
      const input = document.querySelector("input") as HTMLInputElement;
      input.focus();
      fireEvent.input(input, { target: { value: "Store" } });
      if (dismissal === "blur") (document.querySelector("button") as HTMLButtonElement).focus();
      else fireEvent.keyDown(input, { key: "Escape" });
      resolveResponse({
        ok: true,
        json: async () => [
          { path: "sdk/kv", title: "Key-value storage", headings: [], text: "Store values" },
        ],
      });
      await response;
      // Drain the fetch/json/input-handler continuations, without a timing sleep.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector("#docs-search-results")?.childElementCount).toBe(0);
    },
  );

  it("makes theme controls usable before deferred scripts finish and persists the selected choice", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    document.body.innerHTML =
      '<fieldset data-theme-switch><button data-theme-choice="system"></button><button data-theme-choice="light"></button><button data-theme-choice="dark"></button></fieldset>';
    localStorage.setItem("canvas-drop-theme", "light");
    runInNewContext(THEME_CLIENT_JS, {
      document,
      localStorage,
      URLSearchParams,
      location: { search: "" },
    });
    expect(document.documentElement.classList.contains("theme-ready")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    const dark = document.querySelector('[data-theme-choice="dark"]') as HTMLButtonElement;
    dark.click();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("canvas-drop-theme")).toBe("dark");
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    document.dispatchEvent(new Event("readystatechange"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    (document.querySelector('[data-theme-choice="system"]') as HTMLButtonElement).click();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("canvas-drop-theme")).toBeNull();
  });
});
