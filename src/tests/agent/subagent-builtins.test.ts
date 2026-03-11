import { describe, expect, test } from "bun:test";
import { getAllSubagentConfigs } from "../../agent/subagents";

describe("built-in subagents", () => {
  test("includes reflection subagent in available configs", async () => {
    const configs = await getAllSubagentConfigs();
    expect(configs.reflection).toBeDefined();
    expect(configs.reflection?.name).toBe("reflection");
  });

  test("parses subagent mode and defaults missing mode to stateful", async () => {
    const configs = await getAllSubagentConfigs();

    expect(configs.reflection?.mode).toBe("stateless");
    expect(configs["general-purpose"]?.mode).toBe("stateful");
    expect(configs.memory?.mode).toBe("stateful");
  });
});
