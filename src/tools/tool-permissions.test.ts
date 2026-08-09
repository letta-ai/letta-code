import { describe, expect, test } from "bun:test";
import { TOOL_PERMISSIONS } from "./tool-permissions";

describe("tool permissions", () => {
  test("routes Monitor through permission checks", () => {
    expect(TOOL_PERMISSIONS.Monitor).toEqual({ requiresApproval: true });
  });
});
