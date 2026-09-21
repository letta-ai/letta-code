import { getParentConversationTag } from "@/agent/subagents/parent-conversation";
import type { Backend, ConversationCreateBody } from "@/backend";
import type { ModConversationOpenReason } from "@/mods/types";
import { debugLog } from "@/utils/debug";
import { SUBAGENT_TYPE_ENV } from "@/utils/subagent-launch-marker";

type StartupBackend = Pick<
  Backend,
  | "retrieveConversation"
  | "createConversation"
  | "updateConversation"
  | "updateAgent"
>;

/** Resolve the child scope and save its launcher before local or remote execution. */
export async function resolveHeadlessConversation(options: {
  backend: StartupBackend;
  agent: { id: string; tags?: string[] | null };
  ephemeralConversationId?: string | null;
  specifiedConversationId?: string;
  forceNewConversation?: boolean;
  isSubagent: boolean;
  isAgentLaunch: boolean;
  fromAgentId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  conversationId: string;
  conversationOpenReason: ModConversationOpenReason;
}> {
  const {
    backend,
    agent,
    ephemeralConversationId,
    specifiedConversationId,
    forceNewConversation,
    isSubagent,
    fromAgentId,
  } = options;
  let conversationId: string;
  let conversationOpenReason: ModConversationOpenReason;
  if (ephemeralConversationId) {
    conversationId = ephemeralConversationId;
    conversationOpenReason = "new";
  } else if (specifiedConversationId) {
    // "default" is virtual, so only named conversations need retrieval.
    if (specifiedConversationId !== "default") {
      try {
        debugLog(
          "conversations",
          `retrieve(${specifiedConversationId}) [headless --conv validate]`,
        );
        await backend.retrieveConversation(specifiedConversationId);
      } catch {
        throw new Error(`Conversation ${specifiedConversationId} not found`);
      }
    }
    conversationId = specifiedConversationId;
    conversationOpenReason = "resume";
  } else if (forceNewConversation || !isSubagent) {
    // Fresh threads avoid concurrent runs on the same message history.
    const body: ConversationCreateBody = { agent_id: agent.id };
    if (forceNewConversation && fromAgentId) {
      (body as { hidden?: boolean }).hidden = true;
    }
    conversationId = (await backend.createConversation(body)).id;
    conversationOpenReason = "new";
  } else {
    conversationId = "default";
    conversationOpenReason = "startup";
  }

  // The launch marker is consumed once. An ordinary CLI invoked from a child
  // shell must not claim that child's inherited launcher as its own parent.
  const env = options.env ?? process.env;
  const parentTag = options.isAgentLaunch
    ? getParentConversationTag(
        env.LETTA_PARENT_AGENT_ID,
        env.LETTA_PARENT_CONVERSATION_ID,
      )
    : undefined;
  if (parentTag) {
    if (conversationId === "default") {
      // Fresh agents already receive this tag in their create request.
      if (!agent.tags?.includes(parentTag)) {
        await backend.updateAgent(agent.id, { tags_to_add: [parentTag] });
      }
    } else {
      await backend.updateConversation(conversationId, {
        tags_to_add: [
          parentTag,
          ...(env[SUBAGENT_TYPE_ENV] ? [`type:${env[SUBAGENT_TYPE_ENV]}`] : []),
        ],
      });
    }
  }
  return { conversationId, conversationOpenReason };
}
