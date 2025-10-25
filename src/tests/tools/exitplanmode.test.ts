import { describe, expect, test } from "bun:test";
import { exit_plan_mode } from "../../tools/impl/ExitPlanMode";

describe("ExitPlanMode tool", () => {
  test("returns approval message", async () => {
    const result = await exit_plan_mode({
      plan: "1. Do thing A\n2. Do thing B\n3. Profit",
    });

    expect(result.message).toBeDefined();
    expect(result.message).toContain("approved");
  });

  test("handles empty plan", async () => {
    const result = await exit_plan_mode({ plan: "" });

    expect(result.message).toBeDefined();
  });

  test("accepts markdown formatted plan", async () => {
    const plan = "## Steps\n- Step 1\n- Step 2\n\n**Important:** Read the docs";
    const result = await exit_plan_mode({ plan });

    expect(result.message).toBeDefined();
    expect(result.message).toContain("approved");
  });
});
