import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const captured: { shouldBlockFn?: () => Promise<boolean>; enableBeforeUnload?: () => boolean } = {};
vi.mock("@tanstack/react-router", () => ({
  useBlocker: (opts: typeof captured) => {
    captured.shouldBlockFn = opts.shouldBlockFn;
    captured.enableBeforeUnload = opts.enableBeforeUnload;
    return { status: "idle" };
  },
}));

const { useUnsavedChanges } = await import("../lib/use-unsaved-changes.js");

function Dirty() {
  useUnsavedChanges({ dirty: true });
  return <p>dirty view</p>;
}

describe("unsaved navigation protection after unmount", () => {
  it("blocks while mounted and never blocks once the view has unmounted", async () => {
    const { unmount } = render(<Dirty />);
    expect(await captured.shouldBlockFn?.()).toBe(true);
    expect(captured.enableBeforeUnload?.()).toBe(true);
    unmount();
    // The router may still call a blocker whose passive-effect cleanup hasn't
    // run yet (new.test.tsx flaked on exactly this); it must let the
    // navigation through.
    expect(await captured.shouldBlockFn?.()).toBe(false);
    expect(captured.enableBeforeUnload?.()).toBe(false);
  });
});
