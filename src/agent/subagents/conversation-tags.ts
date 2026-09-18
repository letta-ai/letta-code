import { LETTA_CODE_SUBAGENT_TAG } from "@/agent/agent-tags";
import type { Backend, ConversationUpdateBody } from "@/backend";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";

/** Record Agent launch provenance without changing the conversation's identity. */
export async function tagSubagentConversation(
  backend: Pick<Backend, "retrieveConversation" | "updateConversation">,
  conversationId: string,
  isAgentLaunch: boolean,
): Promise<void> {
  // The default conversation is virtual, with no row to tag. Fresh subagents
  // already carry role:subagent on their agent; never tag an existing agent here.
  if (!isAgentLaunch || conversationId === "default") return;

  try {
    // Core supports conversation tags; letta-client 1.10.2 omits their types.
    const conversation = (await backend.retrieveConversation(
      conversationId,
    )) as Awaited<ReturnType<Backend["retrieveConversation"]>> & {
      tags?: string[];
    };
    const tags = conversation.tags ?? [];
    if (tags.includes(LETTA_CODE_SUBAGENT_TAG)) return;
    const body: ConversationUpdateBody & { tags: string[] } = {
      tags: [...tags, LETTA_CODE_SUBAGENT_TAG],
    };
    await backend.updateConversation(conversationId, body);
  } catch (error) {
    // Missing display provenance must not prevent the subagent doing its work.
    debugWarn(
      "subagents",
      `Could not tag conversation ${conversationId}: ${getErrorMessage(error)}`,
    );
  }
}
