import { getCurrentAgentId } from "@/agent/context";
import { resolveScopedMemoryDir } from "@/agent/memory-filesystem";
import { detectMemoryFormat } from "@/agent/memory-format";
import { getBackend } from "@/backend";
import type { JsonSchema } from "./model-facing-tool";
import { ROOT_MEMORY_TOOL_ASSETS } from "./tool-definitions";

export async function resolveBackendSpecificToolAssets(
  name: string,
  description: string,
  inputSchema: JsonSchema,
): Promise<{ description: string; inputSchema: JsonSchema }> {
  let isLocalMemfs = false;
  try {
    isLocalMemfs = getBackend().capabilities.localMemfs;
  } catch {
    isLocalMemfs = false;
  }

  if (!isLocalMemfs) {
    let agentId = "";
    try {
      agentId = getCurrentAgentId().trim();
    } catch {
      agentId = (process.env.AGENT_ID || "").trim();
    }
    const memoryDir = resolveScopedMemoryDir({
      ...(agentId ? { agentId } : {}),
    });
    const rootAssets =
      memoryDir && detectMemoryFormat(memoryDir, false) === "memfs-v2"
        ? ROOT_MEMORY_TOOL_ASSETS[name as keyof typeof ROOT_MEMORY_TOOL_ASSETS]
        : undefined;
    if (rootAssets) {
      return {
        description: rootAssets.description,
        inputSchema: rootAssets.schema as JsonSchema,
      };
    }
    return { description, inputSchema };
  }

  if (name === "memory_apply_patch" || name === "memory") {
    return {
      description: description.replace(
        "The harness pushes clean committed memory changes after the turn for remote MemFS agents.",
        "Local backend MemFS has no Letta remote; memory changes are committed locally.",
      ),
      inputSchema,
    };
  }

  return { description, inputSchema };
}
