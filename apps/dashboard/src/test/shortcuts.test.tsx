import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { openShortcuts, Shortcuts, ShortcutsHost } from "../components/Shortcuts.js";

describe("Shortcuts cheatsheet", () => {
  it("lists the dashboard shortcuts in a dialog", () => {
    render(<Shortcuts open onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: /Keyboard shortcuts/i });
    expect(dialog).toBeInTheDocument();
    // The four bound shortcuts are described.
    expect(screen.getByText(/Open the command palette/i)).toBeInTheDocument();
    expect(screen.getByText(/Publish the draft/i)).toBeInTheDocument();
    expect(screen.getByText(/Save the draft/i)).toBeInTheDocument();
    expect(screen.getByText(/Show this shortcuts list/i)).toBeInTheDocument();
    // The keycaps for the four chords are rendered.
    const caps = within(dialog).getAllByText(/^(⌘|K|↵|S|\?)$/);
    expect(caps.length).toBeGreaterThanOrEqual(5);
  });

  it("does not render when closed", () => {
    render(<Shortcuts open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ShortcutsHost — the ? shortcut", () => {
  it('opens the cheatsheet on a bare "?"', async () => {
    render(<ShortcutsHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.keyboard("?");
    expect(await screen.findByRole("dialog", { name: /Keyboard shortcuts/i })).toBeInTheDocument();
  });

  it('does NOT open when "?" is typed into a text field', async () => {
    render(
      <>
        <input aria-label="search" />
        <ShortcutsHost />
      </>,
    );
    const input = screen.getByLabelText("search");
    input.focus();
    await userEvent.keyboard("?");
    expect(screen.queryByRole("dialog")).toBeNull();
    // The character still reaches the field.
    expect((input as HTMLInputElement).value).toBe("?");
  });

  it("opens via the openShortcuts() event helper (used by the menu / palette)", async () => {
    render(<ShortcutsHost />);
    openShortcuts();
    expect(await screen.findByRole("dialog", { name: /Keyboard shortcuts/i })).toBeInTheDocument();
  });

  it("Escape closes the cheatsheet", async () => {
    render(<ShortcutsHost />);
    await userEvent.keyboard("?");
    await screen.findByRole("dialog", { name: /Keyboard shortcuts/i });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
