import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "../components/DataTable.js";

describe("DataTable", () => {
  it("renders the header columns, including a label-less actions gutter", () => {
    render(
      <DataTable
        columns={[{ header: "Name" }, { header: "Count", align: "right" }, { srOnly: "Actions" }]}
      >
        <tr>
          <td>Row</td>
          <td>1</td>
          <td>·</td>
        </tr>
      </DataTable>,
    );
    const table = screen.getByRole("table");
    expect(within(table).getByText("Name")).toBeInTheDocument();
    expect(within(table).getByText("Count")).toBeInTheDocument();
    // The actions gutter carries its accessible name via aria-label, not text.
    expect(within(table).getByText("Count").closest("th")).toHaveClass("text-right");
  });

  it("renders the provided body rows when not empty", () => {
    render(
      <DataTable columns={[{ header: "Name" }]}>
        <tr>
          <td>Alice</td>
        </tr>
        <tr>
          <td>Bob</td>
        </tr>
      </DataTable>,
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("shows the empty state and not the rows when isEmpty", () => {
    render(
      <DataTable columns={[{ header: "Name" }]} isEmpty empty={<span>Nothing here</span>}>
        <tr>
          <td>Should not render</td>
        </tr>
      </DataTable>,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.queryByText("Should not render")).not.toBeInTheDocument();
  });
});
