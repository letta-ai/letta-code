import { describe, expect, test } from "bun:test";
import { getAllowedMemoryPrefixes } from "@/permissions/agent-memory-prefixes";
import { CliPermissions } from "@/permissions/cli";
import {
  isMemoryGuardDisabled,
  resolveAllowedAgents,
} from "@/permissions/cross-agent-guard";
import { getRuntimeContext, runWithRuntimeContext } from "@/runtime-context";
import {
  getRuntimeExecutionEnv,
  isRuntimeExecutionSettings,
  type RuntimeExecutionSettings,
} from "./runtime-execution-settings";

function child(parent: string): RuntimeExecutionSettings {
  return {
    agent_role: "subagent",
    parent_agent_id: parent,
    allowed_tools: [`Read(${parent}/**)`],
    disallowed_tools: [`Write(${parent}/private/**)`],
    disable_memory_guard: false,
    memory_directory: `/${parent}/memory`,
    transcript_path: `/${parent}/transcript.jsonl`,
  };
}

describe("runtime execution settings", () => {
  test("interleaved parents keep their permissions, memory and identity", async () => {
    const permissions = new CliPermissions();
    permissions.setAllowedTools("Bash");
    permissions.setMemoryGuardDisabled(true);
    const processEnv = { LETTA_PARENT_AGENT_ID: "stale", MEMORY_DIR: "/stale" };
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runWithRuntimeContext(
      {
        agentId: "child-a",
        workingDirectory: "/a",
        executionSettings: child("parent-a"),
      },
      async () => {
        await paused;
        expect(getRuntimeContext()?.workingDirectory).toBe("/a");
        expect(permissions.getAllowedTools()).toEqual(["Read(parent-a/**)"]);
        expect(permissions.getDisallowedTools()).toEqual([
          "Write(parent-a/private/**)",
        ]);
        expect(isMemoryGuardDisabled()).toBe(false);
        expect(
          getAllowedMemoryPrefixes("child-a").some((path) =>
            path.endsWith("/parent-a/memory"),
          ),
        ).toBe(true);
        expect(
          getAllowedMemoryPrefixes("child-a").some((path) =>
            path.includes("parent-b"),
          ),
        ).toBe(false);
        expect(resolveAllowedAgents({ currentAgentId: "child-a" })).toEqual(
          new Set(["child-a", "parent-a"]),
        );
        expect(
          getRuntimeExecutionEnv(
            processEnv,
            getRuntimeContext()?.executionSettings,
          ),
        ).toMatchObject({
          LETTA_PARENT_AGENT_ID: "parent-a",
          MEMORY_DIR: "/parent-a/memory",
          TRANSCRIPT_PATH: "/parent-a/transcript.jsonl",
        });
      },
    );
    await runWithRuntimeContext(
      {
        agentId: "child-b",
        workingDirectory: "/b",
        executionSettings: child("parent-b"),
      },
      async () => {
        await Promise.resolve();
        expect(permissions.getAllowedTools()).toEqual(["Read(parent-b/**)"]);
        expect(resolveAllowedAgents({ currentAgentId: "child-b" })).toEqual(
          new Set(["child-b", "parent-b"]),
        );
        expect(
          getRuntimeExecutionEnv(
            processEnv,
            getRuntimeContext()?.executionSettings,
          ).MEMORY_DIR,
        ).toBe("/parent-b/memory");
        release();
      },
    );
    await first;
    expect(processEnv).toEqual({
      LETTA_PARENT_AGENT_ID: "stale",
      MEMORY_DIR: "/stale",
    });
    expect(permissions.getAllowedTools()).toEqual(["Bash(:*)"]);
    expect(permissions.isMemoryGuardDisabled()).toBe(true);
  });

  test("an empty scoped launch does not inherit another child", () => {
    const env = getRuntimeExecutionEnv(
      {
        LETTA_PARENT_AGENT_ID: "old",
        LETTA_CODE_AGENT_ROLE: "subagent",
        MEMORY_DIR: "/old",
        LETTA_MEMORY_DIR: "/old",
        TRANSCRIPT_PATH: "/old/transcript",
        HOME: "/home",
      },
      { allowed_tools: [], disallowed_tools: [], disable_memory_guard: false },
    );
    expect(env).toEqual({ HOME: "/home" });
  });

  test("invalid wire settings cannot reach runtime execution", () => {
    expect(isRuntimeExecutionSettings(child("parent"))).toBe(true);
    for (const value of [
      null,
      {},
      { ...child("p"), max_turns: 0 },
      { ...child("p"), tools: [1] },
      { ...child("p"), allowed_tools: "Bash" },
      { ...child("p"), max_turns: Number.POSITIVE_INFINITY },
    ]) {
      expect(isRuntimeExecutionSettings(value)).toBe(false);
    }
  });
});
