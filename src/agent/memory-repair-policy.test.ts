import { expect, test } from "bun:test";
import { getAllSubagentConfigs } from "@/agent/subagents";
import { composeSubagentChildEnv } from "@/agent/subagents/subagent-launcher";
import {
  LETTA_MOD_CAPABILITY_PROFILE_ENV,
  PROVIDERS_ONLY_MOD_CAPABILITY_PROFILE,
} from "@/mods/capabilities";
import {
  isMemoryRepairSession,
  MEMORY_REPAIR_SESSION_ENV,
  MEMORY_REPAIR_SUBAGENT_TYPE,
} from "./memory-repair-policy";

test("repair children retain their memory scope and suppress ordinary lifecycle mods", async () => {
  const config = (await getAllSubagentConfigs())[MEMORY_REPAIR_SUBAGENT_TYPE];
  expect(config?.launchProfile).toBe("memory-subagent");
  expect(config?.allowedTools).toEqual(["Bash", "Read", "Edit", "Write"]);
  const env = composeSubagentChildEnv({
    parentProcessEnv: {},
    parentAgentId: "agent-primary",
    subagentType: MEMORY_REPAIR_SUBAGENT_TYPE,
    launchProfile: config?.launchProfile,
    inheritedPrimaryRoot: "/memory",
    memoryScope: { primaryRoot: "/memory", writableRoots: ["/memory"] },
  });
  expect(isMemoryRepairSession(env)).toBe(true);
  expect(env.MEMORY_DIR).toBe("/memory");
  expect(env[LETTA_MOD_CAPABILITY_PROFILE_ENV]).toBe(
    PROVIDERS_ONLY_MOD_CAPABILITY_PROFILE,
  );
});

test("ordinary children cannot inherit repair-session behavior", () => {
  const env = composeSubagentChildEnv({
    parentProcessEnv: { [MEMORY_REPAIR_SESSION_ENV]: "1" },
    parentAgentId: "agent-primary",
    subagentType: "general-purpose",
    launchProfile: "default",
    inheritedPrimaryRoot: null,
  });
  expect(isMemoryRepairSession(env)).toBe(false);
  expect(isMemoryRepairSession({})).toBe(false);
});
