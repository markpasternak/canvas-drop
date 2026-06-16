import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UserMenu } from "../components/UserMenu.js";
import type { AuthMode, Me } from "../lib/api.js";

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

describe("UserMenu", () => {
  it("is collapsed until the account button is clicked", () => {
    render(<UserMenu me={makeMe()} />);
    const trigger = screen.getByRole("button", { name: /account/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("shows the signed-in name and email in the popover", () => {
    render(<UserMenu me={makeMe()} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("Mark Pasternak");
    expect(menu).toHaveTextContent("mark@example.com");
  });

  it("renders without crashing when name/email are absent (degenerate identity)", () => {
    // A provider (or a stubbed /api/me) may omit name/email; the avatar must not throw.
    const partial = { id: "u1", isAdmin: false, authMode: "oidc" } as unknown as Me;
    render(<UserMenu me={partial} />);
    const trigger = screen.getByRole("button", { name: /account/i });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("falls back to an initial when there is no avatar", () => {
    render(<UserMenu me={makeMe({ avatarUrl: null })} />);
    // Initial of the display name renders in the trigger avatar.
    expect(screen.getByText("M")).toBeInTheDocument();
  });

  it("marks an admin with a labeled badge", () => {
    render(<UserMenu me={makeMe({ isAdmin: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    expect(screen.getByLabelText("Admin")).toBeInTheDocument();
  });

  it("does not show an admin badge for a non-admin", () => {
    render(<UserMenu me={makeMe({ isAdmin: false })} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    expect(screen.queryByLabelText("Admin")).not.toBeInTheDocument();
  });

  for (const mode of ["oidc", "dev"] as const) {
    it(`offers a real sign-out link in ${mode} mode`, () => {
      render(<UserMenu me={makeMe({ authMode: mode })} />);
      fireEvent.click(screen.getByRole("button", { name: /account/i }));
      const signOut = screen.getByRole("menuitem", { name: /sign out/i });
      // A navigation to the server redirect, not a fetch — clears the cookie.
      expect(signOut).toHaveAttribute("href", "/auth/logout");
    });
  }

  it("omits sign-out in proxy mode (the proxy owns identity)", () => {
    render(<UserMenu me={makeMe({ authMode: "proxy" as AuthMode })} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /sign out/i })).not.toBeInTheDocument();
  });

  it("links to the public welcome page via 'About canvas-drop'", () => {
    render(<UserMenu me={makeMe()} />);
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    const about = screen.getByRole("menuitem", { name: /about canvas-drop/i });
    // Real navigation to the server-rendered landing — not an SPA route.
    expect(about).toHaveAttribute("href", "/welcome");
  });

  it("closes on Escape and on an outside click", () => {
    render(<UserMenu me={makeMe()} />);
    const trigger = screen.getByRole("button", { name: /account/i });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
