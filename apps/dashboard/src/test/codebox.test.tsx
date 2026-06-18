import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeBox } from "../components/CodeBox.js";
import { ToastProvider } from "../components/Toast.js";

describe("CodeBox", () => {
  it("renders the inline value without a copy button by default", () => {
    render(<CodeBox value="secret-key-123" />);
    expect(screen.getByText("secret-key-123")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders a copy button that writes the value to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <ToastProvider>
        <CodeBox value="cd_live_abc" copy copyToast="Key copied" />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("cd_live_abc");
  });

  it("renders the block variant as a preformatted code block", () => {
    const snippet = "curl -X PUT https://example.test/deploy";
    render(<CodeBox value={snippet} variant="block" />);
    const pre = screen.getByText(snippet);
    expect(pre.tagName).toBe("PRE");
  });
});
