import { describe, expect, test } from "bun:test";
import {
  describeTaskAgentType,
  listAgentTypes,
  resolveTaskAgentSelection,
} from "./task-agent-type";

describe("resolveTaskAgentSelection", () => {
  test("defaults to a fresh letta subagent", () => {
    expect(resolveTaskAgentSelection({})).toEqual({
      selection: {
        kind: "letta",
        subagentType: "general-purpose",
        forkContext: false,
      },
    });
  });

  test("letta with fork_context runs the forked config", () => {
    expect(
      resolveTaskAgentSelection({ agent_type: "letta", fork_context: true }),
    ).toEqual({
      selection: { kind: "letta", subagentType: "fork", forkContext: true },
    });
  });

  test.each([
    [
      { subagent_type: "general-purpose" },
      { kind: "letta", subagentType: "general-purpose", forkContext: false },
    ],
    [
      { subagent_type: "fork" },
      { kind: "letta", subagentType: "fork", forkContext: true },
    ],
    [
      { subagent_type: "fork", fork_context: true },
      { kind: "letta", subagentType: "fork", forkContext: true },
    ],
    [
      { subagent_type: "codex" },
      { kind: "external", type: "codex", forkContext: false },
    ],
    [
      { subagent_type: "recall" },
      { kind: "letta", subagentType: "recall", forkContext: false },
    ],
    [
      { subagent_type: "my-reviewer" },
      { kind: "letta", subagentType: "my-reviewer", forkContext: false },
    ],
  ])("maps deprecated subagent_type %j", (args, selection) => {
    expect(resolveTaskAgentSelection(args)).toEqual({ selection } as never);
  });

  test.each(["claude-code", "codex", "cursor", "opencode"])(
    "routes agent_type %s to the external worker",
    (agent_type) => {
      expect(
        resolveTaskAgentSelection({ agent_type, fork_context: true }),
      ).toEqual({
        selection: { kind: "external", type: agent_type, forkContext: true },
      } as never);
    },
  );

  test("accepts matching agent_type and subagent_type", () => {
    expect(
      resolveTaskAgentSelection({
        agent_type: "letta",
        subagent_type: "general-purpose",
      }),
    ).toHaveProperty("selection.subagentType", "general-purpose");
  });

  test.each([
    { agent_type: "codex", subagent_type: "claude-code" },
    { agent_type: "letta", subagent_type: "fork" },
    { subagent_type: "fork", fork_context: false },
    { agent_type: "" },
    { agent_type: 3 },
    { fork_context: "yes" },
  ])("rejects contradictory or malformed input %j", (args) => {
    expect(resolveTaskAgentSelection(args)).toHaveProperty("error");
  });

  test("describes internal letta configs as letta", () => {
    for (const args of [{}, { fork_context: true }, { agent_type: "recall" }]) {
      const result = resolveTaskAgentSelection(args);
      if ("error" in result) throw new Error(result.error);
      expect(describeTaskAgentType(result.selection)).toBe(
        args.agent_type ?? "letta",
      );
    }
  });

  test("suggests letta and external workers, hiding internal configs", () => {
    expect(
      listAgentTypes(["general-purpose", "fork", "memory", "recall"]).split(
        ", ",
      ),
    ).toEqual([
      "letta",
      "claude-code",
      "codex",
      "opencode",
      "cursor",
      "recall",
    ]);
  });
});
