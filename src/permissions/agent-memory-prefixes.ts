import { homedir } from "node:os";
import { resolve } from "node:path";
import { getRuntimeContext } from "@/runtime-context";
import { getRuntimeExecutionEnv } from "@/runtime-execution-settings";

/** Memory locations approved for scoped read-only shell commands. */
export function getAllowedMemoryPrefixes(agentId: string): string[] {
  const env = getRuntimeExecutionEnv(
    process.env,
    getRuntimeContext()?.executionSettings,
  );
  const parentId = env.LETTA_PARENT_AGENT_ID;
  const ids =
    parentId && parentId !== agentId ? [agentId, parentId] : [agentId];
  return ids.flatMap((id) =>
    ["memory", "memory-worktrees"].map((directory) =>
      resolve(homedir(), ".letta", "agents", id, directory).replace(/\\/g, "/"),
    ),
  );
}
