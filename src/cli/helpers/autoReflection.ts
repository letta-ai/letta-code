import { getClient } from "../../agent/client";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { settingsManager } from "../../settings-manager";
import { telemetry } from "../../telemetry";
import { debugLog, debugWarn } from "../../utils/debug";
import { handleMemorySubagentCompletion } from "./memorySubagentCompletion";
import { isReflectionSubagentActive } from "./reflectionGate";
import {
  buildAutoReflectionPayload,
  buildParentMemorySnapshot,
  buildReflectionSubagentPrompt,
  finalizeAutoReflectionPayload,
  type ReflectionSource,
} from "./reflectionTranscript";
import { getSubagents } from "./subagentState";

const AUTO_REFLECTION_DESCRIPTION = "Reflect on recent conversations";
type AutomaticReflectionSource = Exclude<ReflectionSource, "manual">;

export type ReflectionRecompileContext = {
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  logRecompileFailure?: (message: string) => void;
};

export type LaunchReflectionInput = {
  agentId: string;
  conversationId: string;
  workingDirectory: string;
  triggerSource: AutomaticReflectionSource;
  waitForCompletion?: boolean;
  emitCompletionNotification?: (message: string) => void | Promise<void>;
  recompileContext: ReflectionRecompileContext;
};

export type LaunchReflectionResult = {
  launched: boolean;
  success?: boolean;
  skippedReason?: "memfs-disabled" | "already-active" | "no-transcript-delta";
};

const reflectionQueueByAgent = new Map<string, Promise<void>>();

function hasActiveReflectionSubagent(
  agentId: string,
  conversationId: string,
): boolean {
  return isReflectionSubagentActive(getSubagents(), agentId, conversationId);
}

function trackSkippedLaunch(
  input: LaunchReflectionInput,
  skippedReason: NonNullable<LaunchReflectionResult["skippedReason"]>,
): LaunchReflectionResult {
  telemetry.trackReflectionSkip(input.triggerSource, {
    agentId: input.agentId,
    conversationId: input.conversationId,
    skippedReason,
  });
  return { launched: false, skippedReason };
}

async function runReflectionLaunch(
  input: LaunchReflectionInput,
): Promise<LaunchReflectionResult> {
  const {
    agentId,
    conversationId,
    workingDirectory,
    triggerSource,
    recompileContext,
  } = input;

  if (!agentId || !settingsManager.isMemfsEnabled(agentId)) {
    return trackSkippedLaunch(input, "memfs-disabled");
  }

  if (hasActiveReflectionSubagent(agentId, conversationId)) {
    debugLog(
      "memory",
      `Skipping auto reflection launch (${triggerSource}) because one is already active`,
    );
    return trackSkippedLaunch(input, "already-active");
  }

  let systemPrompt: string | undefined;
  try {
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);
    systemPrompt = agent.system ?? undefined;
  } catch {
    debugLog("memory", "Failed to fetch agent system prompt for reflection");
  }

  const autoPayload = await buildAutoReflectionPayload(
    agentId,
    conversationId,
    systemPrompt,
  );
  if (!autoPayload) {
    debugLog(
      "memory",
      `Skipping auto reflection launch (${triggerSource}) because transcript has no new content`,
    );
    return trackSkippedLaunch(input, "no-transcript-delta");
  }

  const memoryDir = getMemoryFilesystemRoot(agentId);
  const parentMemory = await buildParentMemorySnapshot(memoryDir);
  const reflectionPrompt = buildReflectionSubagentPrompt({
    transcriptPath: autoPayload.payloadPath,
    memoryDir,
    cwd: workingDirectory,
    parentMemory,
  });

  const { spawnBackgroundSubagentTask, waitForBackgroundSubagentAgentId } =
    await import("../../tools/impl/Task");

  let resolveCompletion: (result: LaunchReflectionResult) => void = () => {};
  const completionPromise = new Promise<LaunchReflectionResult>((resolve) => {
    resolveCompletion = resolve;
  });

  const { subagentId } = spawnBackgroundSubagentTask({
    subagentType: "reflection",
    prompt: reflectionPrompt,
    description: AUTO_REFLECTION_DESCRIPTION,
    silentCompletion: true,
    parentScope: { agentId, conversationId },
    onComplete: async ({ success, error, agentId: reflectionAgentId }) => {
      try {
        telemetry.trackReflectionEnd(triggerSource, success, {
          agentId,
          subagentId: reflectionAgentId ?? undefined,
          conversationId,
          error,
        });
        await finalizeAutoReflectionPayload(
          agentId,
          conversationId,
          autoPayload.payloadPath,
          autoPayload.endSnapshotLine,
          success,
          triggerSource,
        );

        const completionMessage = await handleMemorySubagentCompletion(
          {
            agentId,
            conversationId,
            subagentType: "reflection",
            success,
            error,
          },
          {
            recompileByConversation: recompileContext.recompileByConversation,
            recompileQueuedByConversation:
              recompileContext.recompileQueuedByConversation,
            logRecompileFailure: recompileContext.logRecompileFailure,
          },
        );
        await input.emitCompletionNotification?.(completionMessage);
      } finally {
        resolveCompletion({ launched: true, success });
      }
    },
  });

  const reflectionAgentId = await waitForBackgroundSubagentAgentId(
    subagentId,
    1000,
  );
  telemetry.trackReflectionStart(triggerSource, {
    agentId,
    subagentId: reflectionAgentId ?? undefined,
    conversationId,
    startMessageId: autoPayload.startMessageId,
    endMessageId: autoPayload.endMessageId,
  });

  debugLog("memory", `Auto-launched reflection subagent (${triggerSource})`);
  return await completionPromise;
}

function enqueueReflectionForAgent<T>(
  agentId: string,
  launch: () => Promise<T>,
): Promise<T> {
  const previous = reflectionQueueByAgent.get(agentId) ?? Promise.resolve();
  const launchPromise = previous
    .catch(() => {
      // A previous reflection failure must not poison this agent's queue.
    })
    .then(launch);

  const queueTail = launchPromise
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (reflectionQueueByAgent.get(agentId) === queueTail) {
        reflectionQueueByAgent.delete(agentId);
      }
    });
  reflectionQueueByAgent.set(agentId, queueTail);
  return launchPromise;
}

function enqueueReflectionLaunch(
  input: LaunchReflectionInput,
): Promise<LaunchReflectionResult> {
  return enqueueReflectionForAgent(input.agentId, () =>
    runReflectionLaunch(input),
  );
}

export async function launchReflectionSubagent(
  input: LaunchReflectionInput,
): Promise<LaunchReflectionResult> {
  if (!input.agentId || !settingsManager.isMemfsEnabled(input.agentId)) {
    return trackSkippedLaunch(input, "memfs-disabled");
  }
  if (hasActiveReflectionSubagent(input.agentId, input.conversationId)) {
    return trackSkippedLaunch(input, "already-active");
  }

  const queuedLaunch = enqueueReflectionLaunch(input);
  if (input.waitForCompletion) {
    try {
      return await queuedLaunch;
    } catch (error) {
      debugWarn(
        "memory",
        `Failed to auto-launch reflection subagent (${input.triggerSource}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { launched: false };
    }
  }

  queuedLaunch.catch((error) => {
    debugWarn(
      "memory",
      `Failed to auto-launch reflection subagent (${input.triggerSource}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return { launched: true };
}

export const __autoReflectionTestUtils = {
  resetReflectionQueue() {
    reflectionQueueByAgent.clear();
  },
  enqueueReflectionForAgent,
};
