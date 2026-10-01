import { describe, expect, test } from "bun:test";
import { parseArgs } from "node:util";
import type { SubagentConfig } from "@/agent/subagents";
import { validateConversationDefaultRequiresAgent } from "@/cli/startup-flag-validation";
import { buildSubagentArgs } from "./manager";

const config: SubagentConfig = {
  name: "general-purpose",
  description: "test",
  systemPrompt: "test prompt",
  allowedTools: "all",
  recommendedModel: "inherit",
  skills: [],
  fork: false,
  launchProfile: "default",
};

function targetFlags(agentId?: string, conversationId?: string) {
  const args = buildSubagentArgs(
    "general-purpose",
    config,
    null,
    "Resume the previous task",
    agentId,
    conversationId,
  );
  const { values } = parseArgs({
    args,
    strict: false,
    options: { agent: { type: "string" }, conv: { type: "string" } },
  });
  return {
    args,
    agent: typeof values.agent === "string" ? values.agent : undefined,
    conversation: typeof values.conv === "string" ? values.conv : undefined,
  };
}

describe("subagent resume target", () => {
  test("keeps the owning agent when resuming its default conversation", () => {
    const target = targetFlags("agent-existing", "default");
    expect(target.agent).toBe("agent-existing");
    expect(target.conversation).toBe("default");
    expect(target.args).not.toContain("--new");
    expect(target.args).not.toContain("--new-agent");
    expect(() =>
      validateConversationDefaultRequiresAgent({
        specifiedAgentId: target.agent,
        specifiedConversationId: target.conversation,
        forceNew: false,
      }),
    ).not.toThrow();
  });

  test.each([undefined, "agent-existing"])(
    "keeps globally unique conversations self-identifying (agent=%s)",
    (agentId) => {
      const target = targetFlags(agentId, "conv-existing");
      expect(target.agent).toBeUndefined();
      expect(target.conversation).toBe("conv-existing");
      expect(target.args).not.toContain("--new");
    },
  );

  test("still creates a new conversation for an agent-only deployment", () => {
    const target = targetFlags("agent-existing");
    expect(target.agent).toBe("agent-existing");
    expect(target.conversation).toBeUndefined();
    expect(target.args).toContain("--new");
  });

  test("does not invent an owner for an unscoped default conversation", () => {
    const target = targetFlags(undefined, "default");
    expect(target.agent).toBeUndefined();
    expect(() =>
      validateConversationDefaultRequiresAgent({
        specifiedAgentId: target.agent,
        specifiedConversationId: target.conversation,
        forceNew: false,
      }),
    ).toThrow("--conv default requires --agent <agent-id>");
  });
});
