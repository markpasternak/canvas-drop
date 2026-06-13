import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordField } from "../components/PasswordField.js";
import { ToastProvider } from "../components/Toast.js";

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <ToastProvider>
      <PasswordField label="Password" value={value} onChange={(e) => setValue(e.target.value)} />
    </ToastProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("PasswordField", () => {
  it("masks by default and reveals on the show toggle", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    await user.type(input, "hunter2");
    expect(input.type).toBe("password");

    await user.click(screen.getByRole("button", { name: /show password/i }));
    expect(input.type).toBe("text");
    // toggle flips its own label so the control is self-describing
    await user.click(screen.getByRole("button", { name: /hide password/i }));
    expect(input.type).toBe("password");
  });

  it("copies the current value to the clipboard", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // Override userEvent's own clipboard stub so we can assert the written value.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await user.type(screen.getByLabelText("Password"), "s3cret!");
    await user.click(screen.getByRole("button", { name: /copy password/i }));
    expect(writeText).toHaveBeenCalledWith("s3cret!");
  });

  it("disables reveal and copy when empty (nothing to act on)", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: /show password/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /nothing to copy/i })).toBeDisabled();
  });

  it("shows a fallback error toast when clipboard.writeText rejects", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) },
      configurable: true,
    });

    await user.type(screen.getByLabelText("Password"), "mypassword");
    await user.click(screen.getByRole("button", { name: /copy password/i }));
    expect(await screen.findByText(/copy it manually/i)).toBeInTheDocument();
  });
});
