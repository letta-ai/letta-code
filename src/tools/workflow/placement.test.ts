import { describe, expect, test } from "bun:test";
import {
  normalizeWorkflowComputer,
  rejectUnsupportedPlacement,
  workflowMaxConcurrent,
  workflowQueryPlacement,
} from "./placement.ts";

describe("workflow placement", () => {
  test("uses local cwd only for local execution and honors explicit remote cwd", () => {
    expect(workflowQueryPlacement(undefined, undefined, "/local/repo")).toEqual(
      {
        backend: "local",
        options: { cwd: "/local/repo" },
      },
    );
    expect(
      workflowQueryPlacement(
        { deviceId: "worker-a" },
        undefined,
        "/local/repo",
      ),
    ).toEqual({
      backend: "cloud",
      options: { computer: { deviceId: "worker-a" } },
    });
    expect(
      workflowQueryPlacement("worker-b", "/remote/repo", "/local/repo"),
    ).toEqual({
      backend: "cloud",
      options: { computer: { name: "worker-b" }, cwd: "/remote/repo" },
    });
    expect(
      workflowQueryPlacement({ name: "local" }, undefined, "/local/repo")
        .backend,
    ).toBe("cloud");
  });

  test("accepts SDK selectors and canonicalizes names without ambiguity", () => {
    for (const selector of [
      { deviceId: "worker" },
      { name: "worker" },
      { id: "worker" },
      { connectionId: "worker" },
    ]) {
      expect(normalizeWorkflowComputer(selector)).toEqual(selector);
    }
    expect(normalizeWorkflowComputer("worker")).toEqual(
      normalizeWorkflowComputer({ name: "worker" }),
    );
  });

  test("malformed selectors never fall back to local", () => {
    for (const value of [
      null,
      false,
      1,
      "",
      "  ",
      [],
      {},
      { deviceId: "" },
      { deviceId: 1 },
      { name: "a", deviceId: "b" },
      { sandbox: "a" },
    ]) {
      expect(() => normalizeWorkflowComputer(value)).toThrow(
        "computer must be",
      );
    }
    expect(() => workflowQueryPlacement("worker", "", "/local")).toThrow("cwd");
  });

  test("unsupported provisioning and resource options fail explicitly", () => {
    for (const key of ["sandbox", "resources", "environment"]) {
      expect(() => rejectUnsupportedPlacement({ [key]: [] })).toThrow(
        "does not support",
      );
    }
  });

  test("invalid concurrency cannot leave calls queued forever", () => {
    for (const value of [
      null,
      "2",
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => workflowMaxConcurrent(value)).toThrow(
        "positive safe integer",
      );
    }
    expect(workflowMaxConcurrent(3)).toBe(3);
  });
});
