// Test for --yolo mode with stream-json output
// Verifies that approval_request_message is replaced with auto_approval event

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { permissionMode } from "../permissions/mode";

describe("Headless mode: --yolo with stream-json", () => {
  beforeEach(() => {
    // Reset permission mode before each test
    permissionMode.reset();
  });

  afterEach(() => {
    permissionMode.reset();
  });

  test("bypassPermissions mode should auto-approve all tools", () => {
    permissionMode.setMode("bypassPermissions");

    const result = permissionMode.checkModeOverride("Read");
    expect(result).toBe("allow");

    const result2 = permissionMode.checkModeOverride("Write");
    expect(result2).toBe("allow");

    const result3 = permissionMode.checkModeOverride("Bash");
    expect(result3).toBe("allow");
  });

  test("default mode should not auto-approve", () => {
    permissionMode.setMode("default");

    const result = permissionMode.checkModeOverride("Write");
    expect(result).toBe(null);
  });

  test("acceptEdits mode should only auto-approve edit tools", () => {
    permissionMode.setMode("acceptEdits");

    const writeResult = permissionMode.checkModeOverride("Write");
    expect(writeResult).toBe("allow");

    const editResult = permissionMode.checkModeOverride("Edit");
    expect(editResult).toBe("allow");

    const bashResult = permissionMode.checkModeOverride("Bash");
    expect(bashResult).toBe(null);
  });

  test("plan mode should deny modification tools", () => {
    permissionMode.setMode("plan");

    const readResult = permissionMode.checkModeOverride("Read");
    expect(readResult).toBe("allow");

    const writeResult = permissionMode.checkModeOverride("Write");
    expect(writeResult).toBe("deny");

    const bashResult = permissionMode.checkModeOverride("Bash");
    expect(bashResult).toBe("deny");
  });
});















