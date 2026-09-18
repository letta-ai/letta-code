import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { type ConversationUpdateBody, getBackend } from "@/backend";
import {
  getSubagentDepth,
  MAX_SUBAGENT_DEPTH,
  type RuntimeExecutionSettings,
} from "@/runtime-execution-settings";

interface PreparedSubagentDepth {
  settings?: RuntimeExecutionSettings;
  recoveryRequired: boolean;
}

export function requireSubagentLaunchSettings(
  prepared: PreparedSubagentDepth,
): RuntimeExecutionSettings | undefined {
  if (prepared.recoveryRequired) {
    throw new Error(
      "Subagent launch restrictions were lost. Resume this conversation through Agent with explicit scoped launch settings before continuing.",
    );
  }
  return prepared.settings;
}

/** Persist before dispatch; restore conservatively before preparing any tools. */
export async function prepareSubagentDepth(
  conversation: Conversation | null,
  settings?: RuntimeExecutionSettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreparedSubagentDepth> {
  const marked =
    conversation &&
    (Reflect.get(conversation, "is_subagent") === true ||
      Boolean(Reflect.get(conversation, "parent_agent_id")));
  const depth = getSubagentDepth(env, settings);
  if (depth > 0 && conversation && !marked) {
    const updated = await getBackend().updateConversation(conversation.id, {
      is_subagent: true,
    } as ConversationUpdateBody);
    if (Reflect.get(updated, "is_subagent") !== true) {
      throw new Error(
        "Backend did not persist the subagent conversation marker; refusing to launch",
      );
    }
  }
  const explicitDepth = settings
    ? settings.subagent_depth
    : env.LETTA_SUBAGENT_DEPTH;
  if ((marked || depth > 0) && (depth === 0 || explicitDepth === undefined)) {
    // No parent authorization is inferred from persisted ancestry. If launch
    // restrictions were lost as well, do not reconstruct a broader toolset.
    return {
      recoveryRequired: settings?.tools === undefined,
      settings: {
        ...settings,
        tools: settings?.tools ?? [],
        allowed_tools: settings?.allowed_tools ?? [],
        disallowed_tools: settings?.disallowed_tools ?? [],
        disable_memory_guard: false,
        agent_role: "subagent",
        subagent_depth: MAX_SUBAGENT_DEPTH,
      },
    };
  }
  return { settings, recoveryRequired: false };
}
