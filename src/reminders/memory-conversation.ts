import { getBackend } from "@/backend";
import {
  spawnBackgroundSubagentTask,
  waitForBackgroundSubagentConversationId,
} from "@/tools/impl/task";
import { debugWarn } from "@/utils/debug";

const MEMORY_CONVERSATION_TITLE = "Memory maintenance";
const activeMemoryConversations = new Set<string>();

export interface LaunchMemoryConversationParams {
  agentId: string;
  sourceConversationId: string;
  context: string;
}

export interface LaunchMemoryConversationDependencies {
  spawnTask?: typeof spawnBackgroundSubagentTask;
  waitForConversationId?: typeof waitForBackgroundSubagentConversationId;
  updateConversation?: (
    conversationId: string,
    body: { summary: string },
  ) => Promise<unknown>;
}

export interface LaunchMemoryConversationResult {
  launched: boolean;
  reason?: "already_active" | "launch_failed";
}

export function createMemoryConversationLauncher(params: {
  agentId: string;
  sourceConversationId: string;
}): (context: string) => void {
  return (context) => {
    launchMemoryConversation({ ...params, context });
  };
}

export function buildMemoryConversationPrompt(context: string): string {
  const plainContext = context
    .replaceAll("<system-reminder>", "")
    .replaceAll("</system-reminder>", "")
    .trim();

  return `A background memory operation needs attention. Handle it autonomously in this separate conversation so memory work never interrupts another active conversation.

Resolve the repository state described below. Preserve intended memory changes, verify the repository is clean when finished, and leave a concise final explanation if a safe resolution is not possible. Do not send this context back into the source conversation.

${plainContext}`;
}

export function launchMemoryConversation(
  params: LaunchMemoryConversationParams,
  dependencies: LaunchMemoryConversationDependencies = {},
): LaunchMemoryConversationResult {
  if (activeMemoryConversations.has(params.agentId)) {
    return { launched: false, reason: "already_active" };
  }

  const spawnTask = dependencies.spawnTask ?? spawnBackgroundSubagentTask;
  const waitForConversationId =
    dependencies.waitForConversationId ??
    waitForBackgroundSubagentConversationId;
  const updateConversation =
    dependencies.updateConversation ??
    ((conversationId, body) =>
      getBackend().updateConversation(conversationId, body));

  activeMemoryConversations.add(params.agentId);
  let taskDone = false;
  try {
    const { subagentId } = spawnTask({
      subagentType: "general-purpose",
      displayType: "memory maintenance",
      prompt: buildMemoryConversationPrompt(params.context),
      description: "Resolve memory repository state",
      existingAgentId: params.agentId,
      parentScope: {
        agentId: params.agentId,
        conversationId: params.sourceConversationId,
      },
      silentCompletion: true,
      emitCompletionNotification: false,
      onComplete: async (result) => {
        taskDone = true;
        try {
          if (result.conversationId) {
            await updateConversation(result.conversationId, {
              summary: result.success
                ? `${MEMORY_CONVERSATION_TITLE} — resolved`
                : `${MEMORY_CONVERSATION_TITLE} — needs attention`,
            });
          }
        } catch (error) {
          debugWarn(
            "memory",
            `Failed to update memory maintenance conversation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          activeMemoryConversations.delete(params.agentId);
        }
      },
    });

    void waitForConversationId(subagentId, 10_000)
      .then(async (conversationId) => {
        if (!conversationId || taskDone) return;
        await updateConversation(conversationId, {
          summary: MEMORY_CONVERSATION_TITLE,
        });
      })
      .catch((error) => {
        debugWarn(
          "memory",
          `Failed to title memory maintenance conversation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    return { launched: true };
  } catch (error) {
    activeMemoryConversations.delete(params.agentId);
    debugWarn(
      "memory",
      `Failed to launch memory maintenance conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { launched: false, reason: "launch_failed" };
  }
}
