import { getBackend } from "@/backend";
import {
  spawnBackgroundSubagentTask,
  waitForBackgroundSubagentConversationId,
} from "@/tools/impl/task";
import { debugWarn } from "@/utils/debug";

const MEMORY_CONVERSATION_TITLE = "Memory maintenance";
const activeMemoryConversations = new Set<string>();
const pendingMemoryConversations = new Map<
  string,
  PendingMemoryConversation[]
>();
const scheduledRetries = new Set<string>();
const retryAttempts = new Map<string, number>();
const MAX_RETRY_DELAY_MS = 30_000;

interface PendingMemoryConversation {
  params: LaunchMemoryConversationParams;
  dependencies: LaunchMemoryConversationDependencies;
}

export interface LaunchMemoryConversationParams {
  agentId: string;
  sourceConversationId: string;
  actingUserId?: string;
  context: string;
}

export interface LaunchMemoryConversationDependencies {
  spawnTask?: typeof spawnBackgroundSubagentTask;
  waitForConversationId?: typeof waitForBackgroundSubagentConversationId;
  updateConversation?: (
    conversationId: string,
    body: { summary: string },
  ) => Promise<unknown>;
  scheduleRetry?: (callback: () => void, delayMs: number) => void;
}

export interface LaunchMemoryConversationResult {
  launched: boolean;
  reason?: "queued" | "launch_failed";
}

export function createMemoryConversationLauncher(params: {
  agentId: string;
  sourceConversationId: string;
  actingUserId?: string;
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
  const queue = pendingMemoryConversations.get(params.agentId) ?? [];
  queue.push({ params, dependencies });
  pendingMemoryConversations.set(params.agentId, queue);
  return drainMemoryConversationQueue(params.agentId);
}

function drainMemoryConversationQueue(
  agentId: string,
): LaunchMemoryConversationResult {
  if (activeMemoryConversations.has(agentId)) {
    return { launched: false, reason: "queued" };
  }

  const pending = pendingMemoryConversations.get(agentId)?.[0];
  if (!pending) return { launched: false, reason: "queued" };
  const { params, dependencies } = pending;

  const spawnTask = dependencies.spawnTask ?? spawnBackgroundSubagentTask;
  const waitForConversationId =
    dependencies.waitForConversationId ??
    waitForBackgroundSubagentConversationId;
  const updateConversation =
    dependencies.updateConversation ??
    ((conversationId, body) =>
      getBackend().updateConversation(conversationId, body));

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
      actingUserId: params.actingUserId,
      silentCompletion: true,
      emitCompletionNotification: false,
      onComplete: async (result) => {
        taskDone = true;
        activeMemoryConversations.delete(params.agentId);
        drainMemoryConversationQueue(params.agentId);
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
        }
      },
    });
    activeMemoryConversations.add(params.agentId);
    retryAttempts.delete(params.agentId);
    pendingMemoryConversations.get(params.agentId)?.shift();
    if (pendingMemoryConversations.get(params.agentId)?.length === 0) {
      pendingMemoryConversations.delete(params.agentId);
    }

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
    debugWarn(
      "memory",
      `Failed to launch memory maintenance conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    scheduleMemoryConversationRetry(params.agentId, dependencies);
    return { launched: false, reason: "launch_failed" };
  }
}

function scheduleMemoryConversationRetry(
  agentId: string,
  dependencies: LaunchMemoryConversationDependencies,
): void {
  if (scheduledRetries.has(agentId)) return;
  scheduledRetries.add(agentId);
  const attempt = (retryAttempts.get(agentId) ?? 0) + 1;
  retryAttempts.set(agentId, attempt);
  const delayMs = Math.min(1_000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
  const retry = () => {
    scheduledRetries.delete(agentId);
    drainMemoryConversationQueue(agentId);
  };
  if (dependencies.scheduleRetry) {
    dependencies.scheduleRetry(retry, delayMs);
    return;
  }
  const timer = setTimeout(retry, delayMs);
  timer.unref();
}
