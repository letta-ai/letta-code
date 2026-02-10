import { describe, expect, test } from "bun:test";
import { permissionMode } from "../../permissions/mode";
import { exit_plan_mode } from "../../tools/impl/ExitPlanMode";

describe("ExitPlanMode tool", () => {
  test("restores prior permission mode when exiting plan mode", async () => {
    permissionMode.reset();
    permissionMode.setMode("bypassPermissions");
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath("/tmp/test-plan.md");

    await exit_plan_mode();

    expect(permissionMode.getMode()).toBe("bypassPermissions");
    expect(permissionMode.getPlanFilePath()).toBeNull();
  });

  test("falls back to default mode when previous mode is unavailable", async () => {
    permissionMode.reset();
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath("/tmp/test-plan.md");

    await exit_plan_mode();

    expect(permissionMode.getMode()).toBe("default");
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
});
