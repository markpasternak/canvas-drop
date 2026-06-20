import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import type { AdminConfigField } from "../lib/api.js";
import { EditableRow } from "../routes/admin.settings.js";

function renderRow(field: AdminConfigField) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <EditableRow field={field} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const designSkinField: AdminConfigField = {
  key: "core.designSkin",
  env: "CANVAS_DROP_DESIGN_SKIN",
  group: "Core",
  label: "Design skin",
  type: "enum",
  enumValues: ["editorial", "studio", "workshop", "canvas"],
  editable: true,
  source: "environment",
  overridden: false,
  secret: false,
  value: "editorial",
};

describe("admin configuration — enum field (the design-skin flip control)", () => {
  it("renders a <select> with every enum option, defaulted to the current value", () => {
    renderRow(designSkinField);
    const select = screen.getByRole("combobox", { name: "Design skin" }) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    for (const v of ["editorial", "studio", "workshop", "canvas"]) {
      expect(within(select).getByRole("option", { name: v })).toBeInTheDocument();
    }
    expect(select.value).toBe("editorial");
  });

  it("still renders a text input for a non-enum string field", () => {
    renderRow({
      ...designSkinField,
      key: "core.baseUrl",
      label: "Base URL",
      type: "string",
      enumValues: undefined,
      value: "http://localhost",
    });
    expect(screen.queryByRole("combobox", { name: "Base URL" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Base URL" })).toBeInTheDocument();
  });
});
