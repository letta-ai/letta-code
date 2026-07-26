import { regenerateConversationDescription } from "@/agent/conversation-description";
import type { ConversationMessageCompactBody } from "@/backend";
import { getBackend } from "@/backend";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import { DEFAULT_SUMMARIZATION_MODEL } from "@/constants";
import { runPreCompactHooks } from "@/hooks";
import { settingsManager } from "@/settings-manager";
import { debugLog } from "@/utils/debug";
import { getConversationWorkingDirectory } from "@/websocket/listener/cwd";
import type { ListenerTransport } from "@/websocket/listener/transport";
import { buildMaybeLaunchReflectionSubagent } from "@/websocket/listener/turn-events";
import type { ConversationRuntime } from "@/websocket/listener/types";

type CompactMode =
  | "all"
  | "sliding_window"
  | "self_compact_all"
  | "self_compact_sliding_window";

const VALID_COMPACT_MODES = new Set<CompactMode>([
  "all",
  "sliding_window",
  "self_compact_all",
  "self_compact_sliding_window",
]);

export class CompactUsageError extends Error {}
export class CompactBlockedError extends Error {}

function compactHelpOutput(): string {
  return [
    "/compact help",
    "",
    "Summarize conversation history (compaction).",
    "",
    "USAGE",
    "  /compact                   — compact with default mode",
    "  /compact all               — compact all messages",
    "  /compact sliding_window    — compact with sliding window",
    "  /compact self_compact_all  — compact with self compact all",
    "  /compact self_compact_sliding_window  — compact with self compact sliding window",
    "  /compact help              — show this help",
  ].join("\n");
}

export async function runCompactCommand(params: {
  socket: ListenerTransport;
  conversationRuntime: ConversationRuntime;
  args: string | undefined;
}): Promise<string> {
  const { socket, conversationRuntime, args } = params;
  const agentId = conversationRuntime.agentId;
  if (!agentId) {
    throw new Error("No agent ID available for /compact command");
  }

  const rawModeArg = args?.trim().split(/\s+/)[0];
  if (rawModeArg === "help") {
    return compactHelpOutput();
  }

  const modeArg = rawModeArg as CompactMode | undefined;
  if (modeArg && !VALID_COMPACT_MODES.has(modeArg)) {
    throw new CompactUsageError(
      `Invalid mode "${modeArg}". Run /compact help for usage.`,
    );
  }

  const workingDirectory = getConversationWorkingDirectory(
    conversationRuntime.listener,
    agentId,
    conversationRuntime.conversationId,
  );
  const preCompactResult = await runPreCompactHooks(
    undefined,
    undefined,
    agentId,
    conversationRuntime.conversationId,
    workingDirectory,
  );
  if (preCompactResult.blocked) {
    const feedback = preCompactResult.feedback.join("\n") || "Blocked by hook";
    throw new CompactBlockedError(`Compact blocked: ${feedback}`);
  }

  const backend = getBackend();
  const modeDisplay = modeArg ? ` (mode: ${modeArg})` : "";

  try {
    let compactParams: ConversationMessageCompactBody | undefined;
    if (modeArg) {
      const agent = await backend.retrieveAgent(agentId);
      compactParams = {
        compaction_settings: {
          mode: modeArg,
          model:
            agent.compaction_settings?.model?.trim() ||
            DEFAULT_SUMMARIZATION_MODEL,
        },
      } as ConversationMessageCompactBody;
    }

    const compactBody =
      conversationRuntime.conversationId === "default"
        ? ({
            agent_id: agentId,
            ...(compactParams ?? {}),
          } as ConversationMessageCompactBody)
        : compactParams;

    const result = await backend.compactConversationMessages(
      conversationRuntime.conversationId,
      compactBody,
    );

    try {
      const reflectionSettings = getReflectionSettings(
        agentId,
        workingDirectory,
      );
      if (
        reflectionSettings.trigger === "compaction-event" &&
        settingsManager.isMemfsEnabled(agentId)
      ) {
        void buildMaybeLaunchReflectionSubagent({
          runtime: conversationRuntime,
          socket,
          agentId,
          conversationId: conversationRuntime.conversationId,
        })("compaction-event");
      }
    } catch (reflectionError) {
      debugLog(
        "memory",
        "Skipping post-compaction reflection:",
        reflectionError instanceof Error
          ? reflectionError.message
          : String(reflectionError),
      );
    }
    void regenerateConversationDescription(conversationRuntime.conversationId);

    return [
      `Compaction completed${modeDisplay}. Message buffer length reduced from ${result.num_messages_before} to ${result.num_messages_after}.`,
      "",
      `Summary: ${result.summary}`,
    ].join("\n");
  } catch (error) {
    const apiError = error as {
      status?: number;
      error?: { detail?: string };
    };
    const detail = apiError?.error?.detail;
    if (
      apiError?.status === 400 &&
      detail?.includes("Summarization failed to reduce the number of messages")
    ) {
      return "Compaction run, but the number of messages is the same";
    }

    throw new Error(formatErrorDetails(error, agentId));
  }
}
