import { resolve } from "node:path";
import { getRuntimeContext } from "@/runtime-context";
import { getRuntimeExecutionEnv } from "@/runtime-execution-settings";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

/** Memory locations approved for scoped read-only shell commands. */
export function getAllowedMemoryPrefixes(agentId: string): string[] {
  const env = getRuntimeExecutionEnv(
    process.env,
    getRuntimeContext()?.executionSettings,
  );
  const parentId = env.LETTA_PARENT_AGENT_ID;
  const ids =
    parentId && parentId !== agentId ? [agentId, parentId] : [agentId];
  const configDir = resolveGlobalConfigDir(env);
  return ids.flatMap((id) =>
    ["memory", "memory-worktrees"].map((directory) =>
      resolve(configDir, "agents", id, directory).replace(/\\/g, "/"),
    ),
  );
}
