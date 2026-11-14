import { describe, expect, test } from "bun:test";
import {
  applySubagentPreset,
  listSubagentTypes,
  resolveTaskAgentSelection,
  shouldForkTaskContext,
} from "./task-agent-selection";

describe("Agent launch selection", () => {
  test.each([
    [{}, { kind: "letta", subagentType: "fork" }],
    [
      { agent_id: "existing" },
      { kind: "letta", subagentType: "general-purpose" },
    ],
    [
      { conversation_id: "conv-existing" },
      { kind: "letta", subagentType: "general-purpose" },
    ],
    [
      { fork_context: false },
      { kind: "letta", subagentType: "general-purpose" },
    ],
    [{ fork_context: true }, { kind: "letta", subagentType: "fork" }],
    [{ harness: " letta " }, { kind: "letta", subagentType: "fork" }],
    [
      { subagent_type: " recall ", harness: "codex", fork_context: false },
      { kind: "letta", subagentType: "recall" },
    ],
    [
      {
        subagent_type: "reviewer",
        harness: "invalid",
        fork_context: "ignored",
      },
      { kind: "letta", subagentType: "reviewer" },
    ],
    [{ harness: "claude-code" }, { kind: "external", type: "claude-code" }],
    [{ harness: "codex" }, { kind: "external", type: "codex" }],
    [{ harness: "cursor" }, { kind: "external", type: "cursor" }],
    [{ harness: "opencode" }, { kind: "external", type: "opencode" }],
  ] as const)("resolves %j", (args, selection) => {
    expect(resolveTaskAgentSelection(args)).toEqual({ selection });
  });

  test("new launches inherit context, existing targets and presets do not", () => {
    expect(shouldForkTaskContext({})).toBe(true);
    expect(shouldForkTaskContext({ fork_context: false })).toBe(false);
    expect(shouldForkTaskContext({ agent_id: "existing" })).toBe(false);
    expect(shouldForkTaskContext({ conversation_id: "default" })).toBe(false);
    expect(shouldForkTaskContext({ subagent_type: "reviewer" })).toBe(false);
    expect(
      shouldForkTaskContext({ agent_id: "existing", fork_context: true }),
    ).toBe(true);
  });

  test.each([
    { harness: "" },
    { harness: 3 },
    { harness: "recall" },
    { subagent_type: "" },
    { subagent_type: 3 },
    { fork_context: "yes" },
    ...[
      "fork",
      "general-purpose",
      "letta",
      "codex",
      "claude-code",
      "cursor",
      "opencode",
      "init",
      "reflection",
      "memory",
    ].map((subagent_type) => ({ subagent_type })),
  ])("rejects invalid selection %j", (args) => {
    expect(resolveTaskAgentSelection(args)).toHaveProperty("error");
  });

  test("presets discard launch overrides but preserve cancellation and caller metadata", () => {
    const signal = new AbortController().signal;
    const assignment = {
      subagent_type: "recall",
      prompt: "Find the decision",
      description: "Recall decision",
      signal,
      toolCallId: "call-1",
      notifyCaller: true,
    };
    const overrides = {
      harness: "codex",
      fork_context: false,
      model: "override",
      agent_id: "other",
      conversation_id: "other-conversation",
      mcp: { inherit: false },
    };
    const normalized = applySubagentPreset({ ...assignment, ...overrides });
    expect(normalized).toMatchObject(assignment);
    for (const key of Object.keys(overrides))
      expect(normalized[key as keyof typeof normalized]).toBeUndefined();
    expect(applySubagentPreset(overrides)).toBe(overrides);
  });

  test("presets preserve computer routing across normalization", () => {
    const args = { subagent_type: "recall", computer: "build-server" };
    expect(applySubagentPreset(applySubagentPreset(args))).toEqual(args);
  });

  test("error suggestions exclude non-selectable configs", () => {
    expect(
      listSubagentTypes([
        "general-purpose",
        "fork",
        "memory",
        "init",
        "reflection",
        "recall",
        "reviewer",
      ]),
    ).toBe("recall, reviewer");
  });
});
