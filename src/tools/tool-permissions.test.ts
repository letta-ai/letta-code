import { describe, expect, test } from "bun:test";
import { TOOL_PERMISSIONS } from "./tool-permissions";

describe("tool permissions", () => {
  test("requires approval for Monitor", () => {
    expect(TOOL_PERMISSIONS.Monitor).toEqual({ requiresApproval: true });
  });
});
