import { describe, expect, test } from "bun:test";
import { permissionMode } from "../../permissions/mode";
import { exit_plan_mode } from "../../tools/impl/ExitPlanMode";

describe("ExitPlanMode tool", () => {
  test("restores prior permission mode when exiting plan mode", async () => {
    permissionMode.reset();
    permissionMode.setMode("fullAccess");
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath("/tmp/test-plan.md");

    await exit_plan_mode();

    expect(permissionMode.getMode()).toBe("fullAccess");
    expect(permissionMode.getPlanFilePath()).toBeNull();
  });

  test("restores to fullAccess when entering plan from reset state", async () => {
    permissionMode.reset();
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath("/tmp/test-plan.md");

    await exit_plan_mode();

    expect(permissionMode.getMode()).toBe("fullAccess");
    expect(permissionMode.getPlanFilePath()).toBeNull();
  });

  test("restores to default (not memory) when entering plan from memory mode", async () => {
    permissionMode.reset();
    permissionMode.setMode("memory");
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath("/tmp/test-plan.md");

    await exit_plan_mode();

    expect(permissionMode.getMode()).toBe("standard");
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
