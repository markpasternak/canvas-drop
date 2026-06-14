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

  it("collapses a folder on click — children hide and aria-expanded flips to false", async () => {
    render(<FileTree files={[f("assets/app.css")]} selected={null} onSelect={() => {}} />);
    const folder = screen.getByText("assets/").closest("button");
    if (!folder) throw new Error("expected the assets/ folder button");
    // Starts expanded with its child visible.
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("app.css")).toBeInTheDocument();

    await userEvent.click(folder);
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("app.css")).not.toBeInTheDocument();
  });

  it("re-expands a collapsed folder on a second click", async () => {
    render(<FileTree files={[f("assets/app.css")]} selected={null} onSelect={() => {}} />);
    const folder = screen.getByText("assets/").closest("button");
    if (!folder) throw new Error("expected the assets/ folder button");

    await userEvent.click(folder); // collapse
    expect(screen.queryByText("app.css")).not.toBeInTheDocument();
    await userEvent.click(folder); // re-expand
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("app.css")).toBeInTheDocument();
  });

  it("collapses nested folders independently", async () => {
    render(
      <FileTree
        files={[f("assets/app.css"), f("assets/img/logo.svg")]}
        selected={null}
        onSelect={() => {}}
      />,
    );
    const nested = screen.getByText("img/").closest("button");
    if (!nested) throw new Error("expected the nested img/ folder button");

    // Collapsing the nested folder hides only its child; the sibling under assets/ stays.
    await userEvent.click(nested);
    expect(nested).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("logo.svg")).not.toBeInTheDocument();
    expect(screen.getByText("app.css")).toBeInTheDocument();
    // The outer assets/ folder is unaffected and still expanded.
    const outer = screen.getByText("assets/").closest("button");
    expect(outer).toHaveAttribute("aria-expanded", "true");
  });
});
