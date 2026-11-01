import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { canvasRelativePaths, FileDrop } from "../components/DeployFiles.js";

function fileEntry(file: File, fullPath: string) {
  return {
    isDirectory: false,
    isFile: true,
    fullPath,
    name: file.name,
    file: (callback: (value: File) => void) => callback(file),
  };
}

function directoryItem(fullPath: string, entries: ReturnType<typeof fileEntry>[]) {
  return {
    kind: "file",
    type: "",
    getAsFile: () => null,
    webkitGetAsEntry: () => ({
      isDirectory: true,
      isFile: false,
      fullPath,
      name: fullPath.slice(fullPath.lastIndexOf("/") + 1),
      createReader() {
        let consumed = false;
        return {
          readEntries(callback: (value: ReturnType<typeof fileEntry>[]) => void) {
            const batch = consumed ? [] : entries;
            consumed = true;
            callback(batch);
          },
        };
      },
    }),
  };
}

describe("FileDrop with the real dropzone and file-selector", () => {
  it("preserves a top-level HTML file and separate folder contents in one drop", async () => {
    const index = new File(["<h1>Canvas</h1>"], "index.html", { type: "text/html" });
    const style = new File(["body{color:teal}"], "style.css", { type: "text/css" });
    const example = new File(["<h1>Example</h1>"], "index.html", { type: "text/html" });
    const onFiles = vi.fn<(files: File[]) => void>();
    render(<FileDrop label="Drop canvas files" variant="folder" busy={false} onFiles={onFiles} />);

    fireEvent.drop(screen.getByRole("presentation"), {
      dataTransfer: {
        types: ["Files"],
        files: [index],
        items: [
          { kind: "file", type: index.type, getAsFile: () => index },
          directoryItem("/assets", [fileEntry(style, "/assets/style.css")]),
          directoryItem("/examples", [fileEntry(example, "/examples/index.html")]),
        ],
      },
    });

    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    const files = onFiles.mock.calls[0]?.[0] ?? [];
    // The dependency adds this prefix for files without a browser directory entry.
    expect(files[0]).toHaveProperty("path", "./index.html");
    expect(files).toEqual([index, style, example]);
    expect(canvasRelativePaths(files)).toEqual([
      "index.html",
      "assets/style.css",
      "examples/index.html",
    ]);
  });

  it("leaves clipboard-file pastes alone instead of preparing an upload", async () => {
    const file = new File(["image"], "clipboard.png", { type: "image/png" });
    const onFiles = vi.fn<(files: File[]) => void>();
    render(<FileDrop label="Drop canvas files" variant="folder" busy={false} onFiles={onFiles} />);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["Files"],
        files: [file],
        items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      },
    });
    await act(async () => {
      fireEvent(screen.getByRole("presentation"), event);
    });
    expect(onFiles).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
