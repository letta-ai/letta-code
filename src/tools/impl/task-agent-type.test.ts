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
    [{ agent_type: "letta" }, "general-purpose", false],
    [{ agent_type: " letta " }, "general-purpose", false],
    [{ agent_type: "recall" }, "recall", false],
    [{ agent_type: "my-reviewer" }, "my-reviewer", false],
  ])("maps agent_type %j to the %s config", (args, subagentType, fork) => {
    expect(resolveTaskAgentSelection(args)).toEqual({
      selection: { kind: "letta", subagentType, forkContext: fork },
    });
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

  test.each([
    [{ agent_type: "fork" }, "replaced by fork_context: true"],
    [{ agent_type: "fork", fork_context: true }, "replaced by fork_context"],
    [{ agent_type: "general-purpose" }, 'is now the default "letta"'],
    [{ agent_type: " general-purpose " }, 'is now the default "letta"'],
  ])("rejects retired agent_type %j with its migration", (args, message) => {
    const result = resolveTaskAgentSelection(args);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain(message);
  });

  test.each([
    { subagent_type: "general-purpose" },
    { subagent_type: "fork" },
    { subagent_type: "codex" },
    { agent_type: "codex", subagent_type: "codex" },
  ])("rejects the removed subagent_type field %j", (args) => {
    const result = resolveTaskAgentSelection(args as never);
    expect(result).toEqual({
      error:
        'subagent_type was removed; use agent_type (default "letta"), and fork_context: true instead of "fork"',
    });
  });

  test.each([
    { agent_type: "" },
    { agent_type: "  " },
    { agent_type: 3 },
    { fork_context: "yes" },
  ])("rejects malformed input %j", (args) => {
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
