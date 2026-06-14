import { describe, expect, it } from "vitest";
import {
  computeWorkerBudget,
  normalizeVitestArgs,
  sanitizeRunId,
  targetArgsForDashboard,
  vitestWorkerValue,
  withFileReporter,
} from "./test-runner.mjs";

describe("test-runner worker budget", () => {
  it("uses roughly half the machine for one active run", () => {
    expect(computeWorkerBudget({ cores: 10, activeRuns: 1 })).toBe("5");
  });

  it("splits the shared worker pool across active runs", () => {
    expect(computeWorkerBudget({ cores: 10, activeRuns: 2 })).toBe("2");
    expect(computeWorkerBudget({ cores: 10, activeRuns: 3 })).toBe("1");
  });

  it("never drops below one worker", () => {
    expect(computeWorkerBudget({ cores: 2, activeRuns: 8 })).toBe("1");
  });

  it("honors an explicit override", () => {
    expect(computeWorkerBudget({ cores: 10, activeRuns: 3, override: "7" })).toBe("7");
    expect(computeWorkerBudget({ cores: 10, activeRuns: 3, override: "25%" })).toBe("25%");
  });
});

describe("vitestWorkerValue", () => {
  it("accepts integers and percentages", () => {
    expect(vitestWorkerValue("3")).toBe(3);
    expect(vitestWorkerValue("30%")).toBe("30%");
  });

  it("falls back on invalid values", () => {
    expect(vitestWorkerValue("0")).toBe("50%");
    expect(vitestWorkerValue("nope")).toBe("50%");
  });
});

describe("normalizeVitestArgs", () => {
  it("strips the package-manager separator before forwarding to Vitest", () => {
    expect(normalizeVitestArgs(["--", "apps/server/src/db/db.test.ts"])).toEqual([
      "apps/server/src/db/db.test.ts",
    ]);
  });

  it("leaves ordinary args untouched", () => {
    expect(normalizeVitestArgs(["apps/server/src/db/db.test.ts", "-t", "migrates"])).toEqual([
      "apps/server/src/db/db.test.ts",
      "-t",
      "migrates",
    ]);
  });
});

describe("targetArgsForDashboard", () => {
  it("rewrites dashboard file paths relative to the dashboard package", () => {
    expect(targetArgsForDashboard(["apps/dashboard/src/test/editor.test.tsx"])).toEqual([
      "src/test/editor.test.tsx",
    ]);
  });

  it("does not rewrite option values as file paths", () => {
    expect(
      targetArgsForDashboard(["apps/dashboard/src/test/editor.test.tsx", "-t", "apps/dashboard"]),
    ).toEqual(["src/test/editor.test.tsx", "-t", "apps/dashboard"]);
  });
});

describe("sanitizeRunId", () => {
  it("keeps run ids path-safe", () => {
    expect(sanitizeRunId("../bad id/with spaces")).toBe(".._bad_id_with_spaces");
  });

  it("bounds long run ids", () => {
    expect(sanitizeRunId("a".repeat(200))).toHaveLength(120);
  });
});

describe("withFileReporter", () => {
  it("adds verbose reporting for single-file runs", () => {
    expect(withFileReporter(["src/test/editor.test.tsx"])).toEqual([
      "src/test/editor.test.tsx",
      "--reporter=verbose",
    ]);
  });

  it("does not override an explicit reporter", () => {
    expect(withFileReporter(["src/test/editor.test.tsx", "--reporter", "dot"])).toEqual([
      "src/test/editor.test.tsx",
      "--reporter",
      "dot",
    ]);
    expect(withFileReporter(["src/test/editor.test.tsx", "--reporter=dot"])).toEqual([
      "src/test/editor.test.tsx",
      "--reporter=dot",
    ]);
  });
});
