export type StartupTarget =
  | { action: "resume"; agentId: string; conversationId?: string }
  | { action: "select" }
  | {
      action: "create";
      trigger: "force-new" | "fresh-start";
    };

export interface StartupResolutionInput {
  pinnedAgentId: string | null;
  pinnedAgentExists: boolean;
  pinnedCount: number;
  existingPinnedCount: number;

  localAgentId: string | null;
  localConversationId: string | null;
  localAgentExists: boolean;

  globalAgentId: string | null;
  globalAgentExists: boolean;

  fallbackAgentId?: string | null;
  fallbackConversationId?: string | null;

  forceNew: boolean;

  needsModelPicker: boolean;
}

export function resolveStartupTarget(
  input: StartupResolutionInput,
): StartupTarget {
  if (input.forceNew) {
    return { action: "create", trigger: "force-new" };
  }

  if (input.localAgentId && input.localAgentExists) {
    return {
      action: "resume",
      agentId: input.localAgentId,
      conversationId: input.localConversationId ?? undefined,
    };
  }

  if (input.pinnedAgentId && input.pinnedAgentExists) {
    return {
      action: "resume",
      agentId: input.pinnedAgentId,
    };
  }

  if (input.existingPinnedCount > 1) {
    return { action: "select" };
  }

  if (input.globalAgentId && input.globalAgentExists) {
    return {
      action: "resume",
      agentId: input.globalAgentId,
    };
  }

  if (input.fallbackAgentId) {
    return {
      action: "resume",
      agentId: input.fallbackAgentId,
      ...(input.fallbackConversationId
        ? { conversationId: input.fallbackConversationId }
        : {}),
    };
  }

  if (input.needsModelPicker) {
    return { action: "select" };
  }

  if (input.pinnedCount > 0) {
    return { action: "select" };
  }

  return { action: "create", trigger: "fresh-start" };
}
