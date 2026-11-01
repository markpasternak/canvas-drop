import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NativeSelect } from "../components/NativeSelect.js";

describe("NativeSelect", () => {
  it("preserves its label, description, native ref, change event and form value", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLSelectElement>();
    const onChange = vi.fn();
    function Form() {
      const [role, setRole] = useState("viewer");
      return (
        <form aria-label="Access">
          <label htmlFor="role">
            Role
            <NativeSelect
              id="role"
              ref={ref}
              name="role"
              value={role}
              aria-describedby="role-help"
              onChange={(event) => {
                onChange(event.target.value);
                setRole(event.target.value);
              }}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </NativeSelect>
          </label>
          <p id="role-help">Editors can update this canvas.</p>
        </form>
      );
    }
    render(<Form />);
    const select = screen.getByRole("combobox", { name: "Role" });
    expect(select).toHaveAccessibleDescription("Editors can update this canvas.");
    expect(ref.current).toBe(select);
    ref.current?.focus();
    expect(select).toHaveFocus();

    await user.selectOptions(select, "editor");

    expect(onChange).toHaveBeenCalledWith("editor");
    expect(select).toHaveValue("editor");
    const form = screen.getByRole("form", { name: "Access" }) as HTMLFormElement;
    expect(new FormData(form).get("role")).toBe("editor");
  });

  it.each(["direct", "fieldset"] as const)(
    "respects %s disabling without changing or submitting its selection",
    async (mode) => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <form aria-label="Access">
          <fieldset disabled={mode === "fieldset"}>
            <NativeSelect
              aria-label="Role"
              name="role"
              defaultValue="viewer"
              disabled={mode === "direct"}
              onChange={onChange}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </NativeSelect>
          </fieldset>
        </form>,
      );
      const select = screen.getByRole("combobox", { name: "Role" });
      expect(select).toBeDisabled();
      await user.selectOptions(select, "editor");
      expect(select).toHaveValue("viewer");
      expect(onChange).not.toHaveBeenCalled();
      const form = screen.getByRole("form", { name: "Access" }) as HTMLFormElement;
      expect(new FormData(form).has("role")).toBe(false);
    },
  );
});
