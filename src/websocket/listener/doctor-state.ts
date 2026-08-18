import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getLocalMemoryFormat } from "@/agent/memory-format";
import { getBackend } from "@/backend";
import {
  estimateSystemPromptTokensFromMemoryDir,
  setSystemPromptDoctorState,
} from "@/cli/helpers/system-prompt-warning";

export async function refreshSystemPromptDoctorState(
  agentId: string,
): Promise<void> {
  const memoryDir = getScopedMemoryFilesystemRoot(agentId);
  const agent = await getBackend().retrieveAgent(agentId, {
    include: ["agent.tags"],
  });
  const tokens = estimateSystemPromptTokensFromMemoryDir(
    memoryDir,
    getLocalMemoryFormat(agent.tags),
  );
  setSystemPromptDoctorState(agentId, tokens);
}
