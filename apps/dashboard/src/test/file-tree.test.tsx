import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileTree } from "../components/FileTree.js";
import type { DraftFile } from "../lib/api.js";

const f = (path: string): DraftFile => ({ path, size: 1, mime: "text/plain" });

describe("FileTree", () => {
  it("renders an empty hint when there are no files", () => {
    render(<FileTree files={[]} selected={null} onSelect={() => {}} />);
    expect(screen.getByText(/no draft files/i)).toBeInTheDocument();
  });

  it("nests paths into directories and lists files", () => {
    render(
      <FileTree
        files={[f("index.html"), f("assets/app.css"), f("assets/img/logo.svg")]}
        selected={null}
        onSelect={() => {}}
      />,
    );
    // Directory rows for assets/ and img/.
    expect(screen.getByText("assets/")).toBeInTheDocument();
    expect(screen.getByText("img/")).toBeInTheDocument();
    // Leaf file names (basename only in the tree).
    expect(screen.getByText("index.html")).toBeInTheDocument();
    expect(screen.getByText("app.css")).toBeInTheDocument();
    expect(screen.getByText("logo.svg")).toBeInTheDocument();
  });

  it("calls onSelect with the full path when a file is clicked", async () => {
    const onSelect = vi.fn();
    render(<FileTree files={[f("assets/app.css")]} selected={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByText("app.css"));
    expect(onSelect).toHaveBeenCalledWith("assets/app.css");
  });

  it("marks the selected file with aria-current", () => {
    render(<FileTree files={[f("index.html")]} selected="index.html" onSelect={() => {}} />);
    const button = screen.getByText("index.html").closest("button");
    expect(button).toHaveAttribute("aria-current", "true");
  });
});
