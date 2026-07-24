import { describe, expect, test } from "bun:test";
import type { AgentCreateParams } from "@letta-ai/letta-client/resources/agents/agents";
import { applyCreatedAgentServerToolDefaults } from "./runtime-start";

describe("applyCreatedAgentServerToolDefaults", () => {
  test("applies the CLI created-agent defaults when tools are unspecified", () => {
    const body = applyCreatedAgentServerToolDefaults({
      name: "Agent",
      model: "anthropic/claude-sonnet-4-6",
    } as AgentCreateParams);

    expect(body.tools).toEqual(["web_search", "fetch_webpage"]);
    expect(body.include_base_tools).toBe(false);
    expect(body.include_base_tool_rules).toBe(false);
  });

  test("keeps an explicit tools list untouched", () => {
    const input = {
      name: "Agent",
      tools: [],
      include_base_tools: false,
    } as unknown as AgentCreateParams;

    expect(applyCreatedAgentServerToolDefaults(input)).toBe(input);
  });

  test("keeps an explicit include_base_tools untouched even without tools", () => {
    const input = {
      name: "Agent",
      include_base_tools: true,
    } as unknown as AgentCreateParams;

    expect(applyCreatedAgentServerToolDefaults(input)).toBe(input);
  });
});
