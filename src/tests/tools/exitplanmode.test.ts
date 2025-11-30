import { describe, expect, test } from "bun:test";
import { exit_plan_mode } from "../../tools/impl/ExitPlanMode";

describe("ExitPlanMode tool", () => {
  test("returns approval message", async () => {
    const result = await exit_plan_mode();

    expect(result.message).toBeDefined();
    expect(result.message).toContain("approved");
  });

  test("returns message with coding guidance", async () => {
    const result = await exit_plan_mode();

    expect(result.message).toBeDefined();
    expect(result.message).toContain("todo list");
  });
});
