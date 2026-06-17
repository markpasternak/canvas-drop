import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionMenu, ActionMenuItem } from "../components/ActionMenu.js";

function Harness({ onPick, onDisabled }: { onPick?: () => void; onDisabled?: () => void }) {
  return (
    <div>
      <button type="button">outside</button>
      <ActionMenu label="More actions">
        <ActionMenuItem onSelect={onPick}>Duplicate</ActionMenuItem>
        <ActionMenuItem onSelect={onDisabled} disabled title="Not allowed">
          Blocked
        </ActionMenuItem>
        <ActionMenuItem danger onSelect={() => {}}>
          Delete
        </ActionMenuItem>
      </ActionMenu>
    </div>
  );
}

describe("ActionMenu", () => {
  it("opens on click, exposes menu semantics, and focuses the first item", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const first = await screen.findByRole("menuitem", { name: "Duplicate" });
    await waitFor(() => expect(first).toHaveFocus());
  });

  it("runs the item handler and closes on select", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    expect(onPick).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Duplicate" })).not.toBeInTheDocument(),
    );
  });

  it("a disabled item is marked aria-disabled and never fires its handler", async () => {
    const user = userEvent.setup();
    const onDisabled = vi.fn();
    render(<Harness onDisabled={onDisabled} />);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const blocked = await screen.findByRole("menuitem", { name: "Blocked" });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    await user.click(blocked);
    expect(onDisabled).not.toHaveBeenCalled();
  });

  it("roves focus with ArrowDown (skipping the disabled item)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const first = await screen.findByRole("menuitem", { name: "Duplicate" });
    await waitFor(() => expect(first).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    // The disabled "Blocked" item is excluded from the roving order → Delete next.
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    await user.click(trigger);
    await screen.findByRole("menuitem", { name: "Duplicate" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(trigger).toHaveFocus();
  });

  it("closes when an outside element is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    await user.click(trigger);
    await screen.findByRole("menuitem", { name: "Duplicate" });
    await user.click(screen.getByRole("button", { name: "outside" }));
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).not.toBeInTheDocument();
  });
});
