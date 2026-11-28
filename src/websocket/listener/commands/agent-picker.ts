import { isLocalAgentId } from "@/agent/agent-id";
import { unpinAgentForCurrentUser } from "@/agent/favorites";
import { isLocalBackendEnabled } from "@/backend";
import { listLocalAgentsFromDisk } from "@/cli/helpers/local-agent-listing";
import { listPinnedAgentsForCurrentUser } from "@/cli/helpers/pinned-agent-listing";
import { listSharedAgentsForCurrentUser } from "@/cli/helpers/shared-agent-listing";
import type {
  PickerPageRequest,
  PickerPageResponse,
} from "@/types/agent-picker";

export async function readPickerPage(
  request: PickerPageRequest,
): Promise<PickerPageResponse> {
  const base = {
    type: "agent_picker_page_response" as const,
    request_id: request.request_id,
  };
  try {
    const local = isLocalBackendEnabled();
    if (request.collection === "local") {
      return {
        ...base,
        success: true,
        agents: listLocalAgentsFromDisk().map(
          ({ id, name, description, model, last_run_completion }) => ({
            id,
            name,
            description,
            model,
            last_run_completion,
          }),
        ),
      };
    }
    if (request.collection === "pinned") {
      const pins = await listPinnedAgentsForCurrentUser([
        local ? "local" : "api",
      ]);
      return {
        ...base,
        success: true,
        agents: pins.flatMap(({ agent }) =>
          agent
            ? [
                {
                  id: agent.id,
                  name: agent.name,
                  description: agent.description,
                  model: agent.model,
                  memoryBlockCount: agent.blocks?.length,
                  last_run_completion: agent.last_run_completion,
                },
              ]
            : [],
        ),
      };
    }
    if (local) return { ...base, success: true, agents: [] };
    const page = await listSharedAgentsForCurrentUser({
      limit: 20,
      order: "desc",
      orderBy: "last_run_completion",
      after: request.after,
      queryText: request.query,
    });
    return {
      ...base,
      success: true,
      nextCursor: page.nextCursor,
      agents: page.agents.map(
        ({ id, name, description, last_run_completion, creator }) => ({
          id,
          name,
          description,
          last_run_completion,
          creator: creator ? { id: creator.id, name: creator.name } : null,
        }),
      ),
    };
  } catch (error) {
    return {
      ...base,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function unpinPickerAgent(
  request: import("@/types/agent-picker").PickerUnpinRequest,
): Promise<import("@/types/agent-picker").PickerUnpinResponse> {
  const base = {
    type: "agent_picker_unpin_response" as const,
    request_id: request.request_id,
  };
  try {
    if (isLocalAgentId(request.agent_id) !== isLocalBackendEnabled())
      throw new Error("Agent belongs to another backend");
    await unpinAgentForCurrentUser(request.agent_id);
    return { ...base, success: true };
  } catch (error) {
    return {
      ...base,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
