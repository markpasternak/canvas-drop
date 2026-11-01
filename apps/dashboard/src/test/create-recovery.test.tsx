import { afterEach, describe, expect, it } from "vitest";
import {
  clearCreateRecovery,
  readCreateRecovery,
  writeCreateRecovery,
} from "../lib/create-recovery.js";

afterEach(clearCreateRecovery);
describe("create recovery account and secret boundary", () => {
  const value = {
    method: "paste" as const,
    title: "Draft",
    titleEdited: true,
    html: "<h1>Private</h1>",
    slug: "draft",
    workspace: null,
    backendEnabled: false,
    upload: null,
    audience: {
      choice: "public" as const,
      listed: false,
      requirePassword: true,
      password: "not retained",
    },
    apiKey: "not retained either",
    pending: {
      canvas: { id: "c1", url: "https://example.test/c/c1", apiKey: "not retained nested key" },
      files: [],
      next: 1,
      uncertain: true,
    },
  };
  it("keeps form input without retaining extra secrets or writing browser storage", () => {
    writeCreateRecovery("one", value);
    expect(readCreateRecovery("one")).toMatchObject({ html: value.html, title: value.title });
    expect(JSON.stringify(readCreateRecovery("one"))).not.toContain("not retained");
    expect(readCreateRecovery("one")?.pending).toMatchObject({
      canvas: { id: "c1" },
      next: 1,
      uncertain: true,
    });
    clearCreateRecovery();
    expect(readCreateRecovery("one")).toBeUndefined();
  });
  it("clears the prior account rather than reviving it after an account switch", () => {
    writeCreateRecovery("one", value);
    expect(readCreateRecovery("two")).toBeUndefined();
    expect(readCreateRecovery("one")).toBeUndefined();
    writeCreateRecovery("one", value);
    expect(readCreateRecovery(undefined)).toBeUndefined();
    expect(readCreateRecovery("one")).toBeUndefined();
  });
});
