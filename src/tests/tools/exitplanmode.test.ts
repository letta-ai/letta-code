import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PERMISSION_MODE,
  permissionMode,
} from "../../permissions/mode";
import { exit_plan_mode } from "../../tools/impl/ExitPlanMode";

describe("ExitPlanMode tool", () => {
  test("restores prior permission mode when exiting plan mode", async () => {
    permissionMode.reset();
    permissionMode.setMode("unrestricted");
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath("/tmp/test-plan.md");

    await exit_plan_mode();

    expect(permissionMode.getMode()).toBe("unrestricted");
    expect(permissionMode.getPlanFilePath()).toBeNull();
  });

  test("restores to unrestricted when entering plan from reset state", async () => {
    permissionMode.reset();
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath("/tmp/test-plan.md");

    await exit_plan_mode();

    expect(permissionMode.getMode()).toBe("unrestricted");
    expect(permissionMode.getPlanFilePath()).toBeNull();
  });

  test("restores to default (not memory) when entering plan from memory mode", async () => {
    permissionMode.reset();
    permissionMode.setMode("memory");
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath("/tmp/test-plan.md");

    await exit_plan_mode();

    expect(permissionMode.getMode()).toBe("unrestricted");
    expect(permissionMode.getPlanFilePath()).toBeNull();
  });

  test("returns approval message", async () => {
    permissionMode.reset();
    const result = await exit_plan_mode();

    expect(result.message).toBeDefined();
    expect(result.message).toContain("approved");
  });

  test("returns message with coding guidance", async () => {
    permissionMode.reset();
    const result = await exit_plan_mode();

    expect(result.message).toBeDefined();
    expect(result.message).toContain("todo list");
  });

  test("restores standard mode when entering plan from standard mode", async () => {
    // Regression: plan approval should restore the user's previous mode,
    // not silently switch to acceptEdits or a more restrictive mode.
    permissionMode.reset();
    permissionMode.setMode("standard");
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath("/tmp/test-plan.md");

    await exit_plan_mode();

    // The tool restores the previous mode (standard), not acceptEdits
    expect(permissionMode.getMode()).toBe("standard");
    expect(permissionMode.getPlanFilePath()).toBeNull();
  });

  test("restores acceptEdits mode when entering plan from acceptEdits mode", async () => {
    permissionMode.reset();
    permissionMode.setMode("acceptEdits");
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath("/tmp/test-plan.md");

    await exit_plan_mode();

    expect(permissionMode.getMode()).toBe("acceptEdits");
    expect(permissionMode.getPlanFilePath()).toBeNull();
  });
});

describe("plan approval mode restoration logic", () => {
  // These tests verify the logic that useApprovalFlow.handlePlanApprove
  // uses to determine the restored mode after plan approval.
  // The logic is: if previousMode was unrestricted, restore unrestricted.
  // If acceptEdits=true, use acceptEdits. Otherwise restore previousMode
  // (falling back to DEFAULT_PERMISSION_MODE).

  test("DEFAULT_PERMISSION_MODE is unrestricted", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("unrestricted");
  });

  test("plan mode remembers standard as previous mode", () => {
    permissionMode.reset();
    permissionMode.setMode("standard");
    permissionMode.setMode("plan");

    expect(permissionMode.getModeBeforePlan()).toBe("standard");
  });

  test("plan mode remembers acceptEdits as previous mode", () => {
    permissionMode.reset();
    permissionMode.setMode("acceptEdits");
    permissionMode.setMode("plan");

    expect(permissionMode.getModeBeforePlan()).toBe("acceptEdits");
  });

  test("plan mode remembers unrestricted as previous mode", () => {
    permissionMode.reset();
    permissionMode.setMode("unrestricted");
    permissionMode.setMode("plan");

    expect(permissionMode.getModeBeforePlan()).toBe("unrestricted");
  });

  // Simulate the handlePlanApprove(acceptEdits=false) logic:
  // When user picks option 1 ("Yes, proceed"), acceptEdits=false.
  // The restore mode should be the previous mode, not acceptEdits.
  test("handlePlanApprove(acceptEdits=false) restores standard, not acceptEdits", () => {
    permissionMode.reset();
    permissionMode.setMode("standard");
    permissionMode.setMode("plan");

    const previousMode = permissionMode.getModeBeforePlan();
    const acceptEdits = false;

    // Simulate the restore logic from handlePlanApprove
    const restoreMode =
      previousMode === "unrestricted"
        ? "unrestricted"
        : acceptEdits
          ? "acceptEdits"
          : previousMode === "memory"
            ? DEFAULT_PERMISSION_MODE
            : (previousMode ?? DEFAULT_PERMISSION_MODE);

    expect(restoreMode).toBe("standard");
  });

  test("handlePlanApprove(acceptEdits=true) uses acceptEdits", () => {
    permissionMode.reset();
    permissionMode.setMode("standard");
    permissionMode.setMode("plan");

    const previousMode = permissionMode.getModeBeforePlan();
    const acceptEdits = true;

    const restoreMode =
      previousMode === "unrestricted"
        ? "unrestricted"
        : acceptEdits
          ? "acceptEdits"
          : previousMode === "memory"
            ? DEFAULT_PERMISSION_MODE
            : (previousMode ?? DEFAULT_PERMISSION_MODE);

    expect(restoreMode).toBe("acceptEdits");
  });

  test("handlePlanApprove(acceptEdits=false) from unrestricted restores unrestricted", () => {
    permissionMode.reset();
    permissionMode.setMode("unrestricted");
    permissionMode.setMode("plan");

    const previousMode = permissionMode.getModeBeforePlan();
    const acceptEdits = false;

    const restoreMode =
      previousMode === "unrestricted"
        ? "unrestricted"
        : acceptEdits
          ? "acceptEdits"
          : previousMode === "memory"
            ? DEFAULT_PERMISSION_MODE
            : (previousMode ?? DEFAULT_PERMISSION_MODE);

    expect(restoreMode).toBe("unrestricted");
  });
});
