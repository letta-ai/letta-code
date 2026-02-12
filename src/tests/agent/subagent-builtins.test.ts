import { describe, expect, test } from "bun:test";
import { getAllSubagentConfigs } from "../../agent/subagents";

describe("built-in subagents", () => {
  test("includes reflection subagent in available configs", async () => {
    const configs = await getAllSubagentConfigs();
    expect(configs.reflection).toBeDefined();
    expect(configs.reflection?.name).toBe("reflection");
  });
});
