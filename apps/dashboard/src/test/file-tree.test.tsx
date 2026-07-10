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

  it("starts folders collapsed while keeping root files visible", async () => {
    render(
      <FileTree
        files={[f("index.html"), f("assets/app.css"), f("assets/img/logo.svg")]}
        selected={null}
        onSelect={() => {}}
      />,
    );
    // Root directory row + root file are visible; nested content starts hidden.
    expect(screen.getByText("assets/")).toBeInTheDocument();
    expect(screen.getByText("index.html")).toBeInTheDocument();
    expect(screen.queryByText("img/")).not.toBeInTheDocument();
    expect(screen.queryByText("app.css")).not.toBeInTheDocument();
    expect(screen.queryByText("logo.svg")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("assets/"));
    expect(screen.getByText("img/")).toBeInTheDocument();
    expect(screen.getByText("app.css")).toBeInTheDocument();
  });

  it("shows each file's type label and human-readable size", () => {
    render(
      <FileTree
        files={[{ path: "index.html", size: 2048, mime: "text/html" }]}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("HTML · 2.0 KB")).toBeInTheDocument();
  });

  it("calls onSelect with the full path when a file is clicked", async () => {
    const onSelect = vi.fn();
    render(<FileTree files={[f("assets/app.css")]} selected={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByText("assets/"));
    await userEvent.click(screen.getByText("app.css"));
    expect(onSelect).toHaveBeenCalledWith("assets/app.css");
  });

  it("marks the selected file with aria-current", () => {
    render(<FileTree files={[f("index.html")]} selected="index.html" onSelect={() => {}} />);
    const button = screen.getByText("index.html").closest("button");
    expect(button).toHaveAttribute("aria-current", "true");
  });

  it("starts collapsed and expands a folder on click", async () => {
    render(<FileTree files={[f("assets/app.css")]} selected={null} onSelect={() => {}} />);
    const folder = screen.getByText("assets/").closest("button");
    if (!folder) throw new Error("expected the assets/ folder button");
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("app.css")).not.toBeInTheDocument();

    await userEvent.click(folder);
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("app.css")).toBeInTheDocument();
  });

  it("collapses an expanded folder on a second click", async () => {
    render(<FileTree files={[f("assets/app.css")]} selected={null} onSelect={() => {}} />);
    const folder = screen.getByText("assets/").closest("button");
    if (!folder) throw new Error("expected the assets/ folder button");

    await userEvent.click(folder); // expand
    expect(screen.getByText("app.css")).toBeInTheDocument();
    await userEvent.click(folder); // collapse
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("app.css")).not.toBeInTheDocument();
  });

  it("collapses nested folders independently", async () => {
    render(
      <FileTree
        files={[f("assets/app.css"), f("assets/img/logo.svg")]}
        selected={null}
        onSelect={() => {}}
      />,
    );
    const outer = screen.getByText("assets/").closest("button");
    if (!outer) throw new Error("expected the assets/ folder button");
    await userEvent.click(outer);
    const nested = screen.getByText("img/").closest("button");
    if (!nested) throw new Error("expected the nested img/ folder button");

    // Opening the nested folder reveals only its child; the sibling stays visible.
    await userEvent.click(nested);
    expect(nested).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("logo.svg")).toBeInTheDocument();
    expect(screen.getByText("app.css")).toBeInTheDocument();
    // The outer assets/ folder is unaffected and remains expanded.
    expect(outer).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps a folder added after mount collapsed until the user expands it", () => {
    const { rerender } = render(
      <FileTree files={[f("index.html")]} selected={null} onSelect={() => {}} />,
    );

    rerender(
      <FileTree
        files={[f("index.html"), f("assets/app.css")]}
        selected="assets/app.css"
        onSelect={() => {}}
      />,
    );

    const folder = screen.getByText("assets/").closest("button");
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("app.css")).not.toBeInTheDocument();
  });
});
