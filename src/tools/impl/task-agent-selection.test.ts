import { describe, expect, test } from "bun:test";
import {
  describeTaskAgentSelection,
  listSubagentTypes,
  resolveTaskAgentSelection,
  TASK_HARNESSES,
} from "./task-agent-selection";

function errorOf(args: Record<string, unknown>): string {
  const result = resolveTaskAgentSelection(args);
  if (!("error" in result)) throw new Error("expected an error");
  return result.error;
}

describe("resolveTaskAgentSelection", () => {
  test("defaults to a fresh default letta agent", () => {
    expect(resolveTaskAgentSelection({})).toEqual({
      selection: {
        kind: "letta",
        subagentType: "general-purpose",
        specialized: false,
        forkContext: false,
      },
    });
  });

  test.each([{}, { harness: "letta" }, { harness: " letta " }])(
    "%j with fork_context runs the forked config",
    (args) => {
      expect(
        resolveTaskAgentSelection({ ...args, fork_context: true }),
      ).toEqual({
        selection: {
          kind: "letta",
          subagentType: "fork",
          specialized: false,
          forkContext: true,
        },
      });
    },
  );

  test.each([
    [{ subagent_type: "recall" }, "recall"],
    [{ subagent_type: " recall ", harness: "letta" }, "recall"],
    [{ subagent_type: "my-reviewer" }, "my-reviewer"],
  ])("maps %j to the %s config", (args, subagentType) => {
    expect(resolveTaskAgentSelection(args)).toEqual({
      selection: {
        kind: "letta",
        subagentType,
        specialized: true,
        forkContext: false,
      },
    });
  });

  test.each(["claude-code", "codex", "cursor", "opencode"])(
    "routes harness %s to the external worker",
    (harness) => {
      expect(
        resolveTaskAgentSelection({ harness, fork_context: true }),
      ).toEqual({
        selection: { kind: "external", type: harness, forkContext: true },
      } as never);
    },
  );

  test("the harness list is letta plus every external worker", () => {
    expect([...TASK_HARNESSES]).toEqual([
      "letta",
      "claude-code",
      "codex",
      "opencode",
      "cursor",
    ]);
  });

  test.each(["claude-code", "codex", "cursor", "opencode"])(
    "rejects subagent_type with harness %s",
    (harness) => {
      expect(errorOf({ harness, subagent_type: "recall" })).toBe(
        `subagent_type only applies to harness "letta"; omit subagent_type when harness is "${harness}"`,
      );
    },
  );

  test.each([
    [
      { subagent_type: "fork" },
      'subagent_type "fork" was removed; use fork_context: true and omit subagent_type',
    ],
    [
      { subagent_type: " general-purpose " },
      'subagent_type "general-purpose" was removed; omit subagent_type for the default agent',
    ],
    [
      { subagent_type: "letta" },
      '"letta" is a harness, not a subagent_type; omit subagent_type for the default agent',
    ],
  ])("rejects retired subagent_type %j with its migration", (args, error) => {
    expect(errorOf(args)).toBe(error);
  });

  test.each(["claude-code", "codex", "cursor", "opencode"])(
    "points subagent_type %s at harness",
    (name) => {
      expect(errorOf({ subagent_type: name })).toBe(
        `"${name}" is a harness, not a subagent_type; pass harness: "${name}" and omit subagent_type`,
      );
      expect(errorOf({ harness: "codex", subagent_type: name })).toContain(
        `pass harness: "${name}"`,
      );
    },
  );

  test.each(["init", "reflection", "memory"])(
    "rejects internal subagent_type %s",
    (name) => {
      expect(errorOf({ subagent_type: name })).toBe(
        `"${name}" is an internal subagent type launched by the harness; it cannot be selected with subagent_type`,
      );
    },
  );

  test.each([
    { agent_type: "letta" },
    { agent_type: "codex" },
    { agent_type: "recall", subagent_type: "recall" },
  ])("rejects the renamed agent_type field %j", (args) => {
    expect(errorOf(args)).toBe(
      'agent_type was renamed to harness; pass harness ("letta", "claude-code", "codex", "opencode", "cursor") and, for a specialized Letta subagent, subagent_type',
    );
  });

  test.each([
    { harness: "" },
    { harness: "  " },
    { harness: 3 },
    { harness: "recall" },
    { subagent_type: "" },
    { subagent_type: 3 },
    { fork_context: "yes" },
  ])("rejects malformed input %j", (args) => {
    expect(resolveTaskAgentSelection(args)).toHaveProperty("error");
  });

  test("describes selections as callers name them", () => {
    const describe = (args: Record<string, unknown>) => {
      const result = resolveTaskAgentSelection(args);
      if ("error" in result) throw new Error(result.error);
      return describeTaskAgentSelection(result.selection);
    };
    expect(describe({})).toBe('harness "letta"');
    expect(describe({ fork_context: true })).toBe('harness "letta"');
    expect(describe({ subagent_type: "recall" })).toBe(
      'subagent_type "recall"',
    );
    expect(describe({ harness: "codex" })).toBe("codex");
  });

  test("suggests only selectable subagent types", () => {
    expect(
      listSubagentTypes([
        "general-purpose",
        "fork",
        "memory",
        "init",
        "reflection",
        "recall",
        "my-reviewer",
      ]),
    ).toBe("recall, my-reviewer");
    expect(listSubagentTypes(["general-purpose", "fork"])).toBe("(none)");
  });
});
