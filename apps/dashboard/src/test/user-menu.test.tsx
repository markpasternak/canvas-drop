import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserMenu } from "../components/UserMenu.js";
import type { AuthMode, Me } from "../lib/api.js";
import { ThemeProvider } from "../lib/theme.js";

function makeMe(overrides: Partial<Me> = {}): Me {
  return {
    id: "u1",
    email: "mark@example.com",
    name: "Mark Pasternak",
    avatarUrl: null,
    isAdmin: false,
    canPublishPublic: false,
    authMode: "oidc",
    urlMode: "path",
    baseUrl: "http://localhost:8787",
    ...overrides,
  };
}

/** UserMenu reads the theme via {@link ThemeProvider}; every render needs the
 * provider in the tree. */
function renderMenu(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

// The theme choice persists to localStorage + the documentElement; reset both so
// theme-selection assertions don't leak between tests.
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("UserMenu", () => {
  it("is collapsed until the account button is clicked", () => {
    renderMenu(<UserMenu me={makeMe()} />);
    const trigger = screen.getByRole("button", { name: /account/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("shows the signed-in name and email in the popover", () => {
    renderMenu(<UserMenu me={makeMe()} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("Mark Pasternak");
    expect(menu).toHaveTextContent("mark@example.com");
  });

  it("renders without crashing when name/email are absent (degenerate identity)", () => {
    // A provider (or a stubbed /api/me) may omit name/email; the avatar must not throw.
    const partial = { id: "u1", isAdmin: false, authMode: "oidc" } as unknown as Me;
    renderMenu(<UserMenu me={partial} />);
    const trigger = screen.getByRole("button", { name: /account/i });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("falls back to an initial when there is no avatar", () => {
    renderMenu(<UserMenu me={makeMe({ avatarUrl: null })} />);
    // Initial of the display name renders in the trigger avatar.
    expect(screen.getByText("M")).toBeInTheDocument();
  });

  it("marks an admin with a labeled badge", () => {
    renderMenu(<UserMenu me={makeMe({ isAdmin: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    expect(screen.getByLabelText("Admin")).toBeInTheDocument();
  });

  it("does not show an admin badge for a non-admin", () => {
    renderMenu(<UserMenu me={makeMe({ isAdmin: false })} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    expect(screen.queryByLabelText("Admin")).not.toBeInTheDocument();
  });

  for (const mode of ["oidc", "dev"] as const) {
    it(`offers a real sign-out link in ${mode} mode`, () => {
      renderMenu(<UserMenu me={makeMe({ authMode: mode })} />);
      fireEvent.click(screen.getByRole("button", { name: /account/i }));
      const signOut = screen.getByRole("menuitem", { name: /sign out/i });
      // A navigation to the server redirect, not a fetch — clears the cookie.
      expect(signOut).toHaveAttribute("href", "/auth/logout");
    });
  }

  it("omits sign-out in proxy mode (the proxy owns identity)", () => {
    renderMenu(<UserMenu me={makeMe({ authMode: "proxy" as AuthMode })} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /sign out/i })).not.toBeInTheDocument();
  });

  it("links to the public welcome page via 'About canvas-drop'", () => {
    renderMenu(<UserMenu me={makeMe()} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    const about = screen.getByRole("menuitem", { name: /about canvas-drop/i });
    // Real navigation to the server-rendered landing — not an SPA route.
    expect(about).toHaveAttribute("href", "/welcome");
  });

  it("opens DOWNWARD by default (top-anchored popover for the mobile top bar)", () => {
    renderMenu(<UserMenu me={makeMe()} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    const menu = screen.getByRole("menu");
    // The default placement anchors the popover below the trigger.
    expect(menu.className).toContain("top-[calc(100%+0.5rem)]");
    expect(menu.className).not.toContain("bottom-[calc(100%+0.5rem)]");
  });

  it("placement='up' opens the popover UPWARD (for the bottom-pinned rail footer)", () => {
    renderMenu(<UserMenu me={makeMe()} placement="up" />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    const menu = screen.getByRole("menu");
    // Bottom-anchored so the menu appears ABOVE a trigger pinned to the viewport
    // bottom, instead of falling below the fold.
    expect(menu.className).toContain("bottom-[calc(100%+0.5rem)]");
    expect(menu.className).not.toContain("top-[calc(100%+0.5rem)]");
  });

  it("expanded trigger shows the display name as a real row (the rail variant)", () => {
    renderMenu(<UserMenu me={makeMe()} expanded />);
    // The name is visible on the trigger itself, not only inside the popover.
    const trigger = screen.getByRole("button", { name: /account/i });
    expect(trigger).toHaveTextContent("Mark Pasternak");
  });

  it("compact trigger (default) does not show the name until the menu opens", () => {
    renderMenu(<UserMenu me={makeMe()} />);
    const trigger = screen.getByRole("button", { name: /account/i });
    // The accessible name carries the label, but the visible trigger text doesn't.
    expect(trigger).not.toHaveTextContent("Mark Pasternak");
  });

  it("closes on Escape and on an outside click", () => {
    renderMenu(<UserMenu me={makeMe()} />);
    const trigger = screen.getByRole("button", { name: /account/i });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("folds the theme switch INTO the menu (a labeled Theme row with the 3 options)", () => {
    renderMenu(<UserMenu me={makeMe()} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    const menu = screen.getByRole("menu");
    // The theme control is the SegmentedControl group inside the popover.
    const theme = within(menu).getByRole("group", { name: "Theme" });
    expect(theme).toBeInTheDocument();
    // All three options are present and reachable as toggle buttons.
    expect(within(theme).getByRole("button", { name: "Use system theme" })).toBeInTheDocument();
    expect(within(theme).getByRole("button", { name: "Use light theme" })).toBeInTheDocument();
    expect(within(theme).getByRole("button", { name: "Use dark theme" })).toBeInTheDocument();
    // A visible "Theme" label accompanies the control.
    expect(within(menu).getByText("Theme")).toBeInTheDocument();
  });

  it("conveys the active theme via aria-pressed and updates it on selection", async () => {
    const user = userEvent.setup();
    renderMenu(<UserMenu me={makeMe()} />);
    await user.click(screen.getByRole("button", { name: /account/i }));
    const theme = within(screen.getByRole("menu")).getByRole("group", { name: "Theme" });

    const system = within(theme).getByRole("button", { name: "Use system theme" });
    const dark = within(theme).getByRole("button", { name: "Use dark theme" });
    // Default is "system" — that option reads pressed, the others do not.
    expect(system).toHaveAttribute("aria-pressed", "true");
    expect(dark).toHaveAttribute("aria-pressed", "false");

    // Selecting Dark via the menu applies the theme (document attribute + persisted)
    // and flips aria-pressed.
    await user.click(dark);
    expect(dark).toHaveAttribute("aria-pressed", "true");
    expect(system).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("canvas-drop-theme")).toBe("dark");
  });

  it("orders the menu: identity header → Theme → About → Sign out", () => {
    renderMenu(<UserMenu me={makeMe()} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    const menu = screen.getByRole("menu");
    const text = menu.textContent ?? "";
    const order = [
      text.indexOf("Mark Pasternak"), // identity header
      text.indexOf("Theme"),
      text.indexOf("About canvas-drop"),
      text.indexOf("Sign out"),
    ];
    // Every item is present and strictly increasing in DOM order.
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("Sign out is last and separated by a divider from the items above it", () => {
    renderMenu(<UserMenu me={makeMe()} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    const signOut = screen.getByRole("menuitem", { name: /sign out/i });
    // The destructive action carries a top border (the divider) and is the last item.
    expect(signOut.className).toContain("border-t");
    const menu = screen.getByRole("menu");
    expect(menu.lastElementChild).toBe(signOut);
  });

  it("opens with the keyboard: Enter on the trigger opens the menu and moves focus inside", async () => {
    const user = userEvent.setup();
    renderMenu(<UserMenu me={makeMe()} />);
    const trigger = screen.getByRole("button", { name: /account/i });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = screen.getByRole("menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Focus moves into the menu (the first focusable — the system-theme button).
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  it("Escape closes the menu and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    renderMenu(<UserMenu me={makeMe()} />);
    const trigger = screen.getByRole("button", { name: /account/i });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("traps Tab within the menu (Shift+Tab from the first focusable wraps to the last)", async () => {
    const user = userEvent.setup();
    renderMenu(<UserMenu me={makeMe()} />);
    await user.click(screen.getByRole("button", { name: /account/i }));
    const menu = screen.getByRole("menu");
    const focusables = menu.querySelectorAll<HTMLElement>("a[href],button:not([disabled])");
    const last = focusables[focusables.length - 1];

    // Focus starts on the first focusable; Shift+Tab wraps to the last, staying inside.
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(last).toHaveFocus();
  });

  it("does not link keyboard shortcuts in the menu (kept app-wide via the `?` binding)", () => {
    renderMenu(<UserMenu me={makeMe()} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    expect(screen.queryByRole("menuitem", { name: /keyboard shortcuts/i })).not.toBeInTheDocument();
  });
});
