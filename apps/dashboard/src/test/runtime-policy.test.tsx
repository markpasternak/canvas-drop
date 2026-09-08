import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RuntimePolicySettings } from "../components/RuntimePolicySettings.js";
import type { Canvas } from "../lib/api.js";
import { emptyPolicy } from "../lib/runtime-policy.js";

const canvas = {
  id: "c1",
  backendEnabled: true,
  status: "active",
  runtimePolicy: emptyPolicy(),
  runtimePolicyRevision: null,
} as Canvas;
describe("runtime policy settings", () => {
  it("uses the default for new resources and leaves existing policies unchanged", async () => {
    const save = vi.fn(async () => ({}));
    const existing = {
      ...canvas,
      runtimePolicy: {
        ...emptyPolicy(),
        collections: { comments: { preset: "contributions" as const } },
      },
    };
    render(
      <RuntimePolicySettings canvas={existing} save={save} pending={false} connectionKeys={[]} />,
    );
    const user = userEvent.setup();
    expect(screen.getByText("Advanced permissions").parentElement).not.toHaveAttribute("open");
    await user.selectOptions(screen.getByLabelText("Default for new resources"), "read_only");
    await user.type(screen.getByLabelText("Resource name"), "settings");
    await user.click(screen.getByRole("button", { name: "Add resource" }));
    await user.click(screen.getByRole("button", { name: "Save permissions" }));
    expect(save).toHaveBeenCalledWith({
      expectedRuntimePolicy: null,
      runtimePolicy: {
        ...emptyPolicy(),
        defaultMode: "read_only",
        collections: { comments: { preset: "contributions" }, settings: { preset: "managed" } },
      },
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Permissions saved");
  });
  it("shows granular rights only when expanded and keeps a failed proposal visible", async () => {
    const save = vi.fn(async () => {
      throw new Error("POLICY_CONFLICT");
    });
    const existing = {
      ...canvas,
      runtimePolicy: {
        ...emptyPolicy(),
        collections: { comments: { preset: "contributions" as const } },
      },
    };
    render(
      <RuntimePolicySettings canvas={existing} save={save} pending={false} connectionKeys={[]} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("Advanced permissions"));
    await user.click(screen.getByText("Customize operations for comments"));
    await user.selectOptions(screen.getByLabelText("comments: delete"), "editors");
    expect(screen.getByText("Review permission changes")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save permissions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "your proposed changes are still shown",
    );
    expect(screen.getByLabelText("comments: delete")).toHaveValue("editors");
  });
  it("retains the original null revision through a background refresh", async () => {
    const save = vi.fn(async () => ({}));
    const { rerender } = render(
      <RuntimePolicySettings canvas={canvas} save={save} pending={false} connectionKeys={[]} />,
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Default for new resources"), "collaboration");
    rerender(
      <RuntimePolicySettings
        canvas={{ ...canvas, runtimePolicyRevision: "new revision" }}
        save={save}
        pending={false}
        connectionKeys={[]}
      />,
    );
    await user.type(screen.getByLabelText("Resource name"), "notes");
    await user.click(screen.getByRole("button", { name: "Add resource" }));
    await user.click(screen.getByRole("button", { name: "Save permissions" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedRuntimePolicy: null }));
  });
});
