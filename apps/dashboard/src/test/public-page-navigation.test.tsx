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
