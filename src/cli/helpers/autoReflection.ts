import { getClient } from "../../agent/client";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { settingsManager } from "../../settings-manager";
import { telemetry } from "../../telemetry";
import {
  spawnBackgroundSubagentTask as defaultSpawnBackgroundSubagentTask,
  waitForBackgroundSubagentAgentId as defaultWaitForBackgroundSubagentAgentId,
} from "../../tools/impl/Task";
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
const SUBAGENT_ID_WAIT_MS = 1000;

export type ReflectionRecompileContext = {
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  logRecompileFailure?: (message: string) => void;
};

type ReflectionCompletionHandler = typeof handleMemorySubagentCompletion;

type ReflectionTaskDeps = {
  isMemfsEnabled?: (agentId: string) => boolean;
  getSystemPrompt?: (agentId: string) => Promise<string | undefined>;
  spawnBackgroundSubagentTask?: (input: {
    subagentType: string;
    prompt: string;
    description: string;
    silentCompletion: boolean;
    parentScope: { agentId: string; conversationId: string };
    onComplete: (result: {
      success: boolean;
      error?: string;
      agentId?: string;
      conversationId?: string;
    }) => void | Promise<void>;
  }) => { subagentId: string };
  waitForBackgroundSubagentAgentId?: (
    subagentId: string,
    timeoutMs: number | null,
  ) => Promise<string | null>;
  handleMemorySubagentCompletion?: ReflectionCompletionHandler;
};

export type LaunchReflectionInput = {
  agentId: string;
  conversationId: string;
  workingDirectory: string;
  triggerSource: ReflectionSource;
  waitUntil?: "queued" | "launched" | "completed";
  waitForCompletion?: boolean;
  emitCompletionNotification?: (message: string) => void | Promise<void>;
  recompileContext: ReflectionRecompileContext;
  deps?: ReflectionTaskDeps;
};

export type LaunchReflectionSkippedReason =
  | "memfs-disabled"
  | "already-active"
  | "no-transcript-delta";

export type LaunchReflectionQueuedResult = {
  status: "queued";
};

export type LaunchReflectionSkippedResult = {
  status: "skipped";
  skippedReason: LaunchReflectionSkippedReason;
};

export type LaunchReflectionLaunchedResult = {
  status: "launched";
  payloadPath: string;
  subagentId?: string;
  reflectionAgentId?: string | null;
  startMessageId?: string;
  endMessageId?: string;
};

export type LaunchReflectionCompletedResult = {
  status: "completed";
  success: boolean;
  payloadPath: string;
  subagentId?: string;
  reflectionAgentId?: string | null;
  startMessageId?: string;
  endMessageId?: string;
};

export type LaunchReflectionFailedResult = {
  status: "failed";
  error: string;
};

export type LaunchReflectionResult =
  | LaunchReflectionQueuedResult
  | LaunchReflectionSkippedResult
  | LaunchReflectionLaunchedResult
  | LaunchReflectionCompletedResult
  | LaunchReflectionFailedResult;

const reflectionQueueByAgent = new Map<string, Promise<void>>();

function hasActiveReflectionSubagent(
  agentId: string,
  conversationId: string,
): boolean {
  return isReflectionSubagentActive(getSubagents(), agentId, conversationId);
}

function trackSkippedLaunch(
  input: LaunchReflectionInput,
  skippedReason: LaunchReflectionSkippedReason,
): LaunchReflectionSkippedResult {
  telemetry.trackReflectionSkip(input.triggerSource, {
    agentId: input.agentId,
    conversationId: input.conversationId,
    skippedReason,
  });
  return { status: "skipped", skippedReason };
}

function getWaitUntil(
  input: LaunchReflectionInput,
): NonNullable<LaunchReflectionInput["waitUntil"]> {
  if (input.waitUntil) {
    return input.waitUntil;
  }
  return input.waitForCompletion ? "completed" : "queued";
}

function isMemfsEnabled(input: LaunchReflectionInput): boolean {
  return (
    input.deps?.isMemfsEnabled ??
    settingsManager.isMemfsEnabled.bind(settingsManager)
  )(input.agentId);
}

async function getSystemPrompt(
  input: LaunchReflectionInput,
): Promise<string | undefined> {
  if (input.deps?.getSystemPrompt) {
    return input.deps.getSystemPrompt(input.agentId);
  }

  try {
    const client = await getClient();
    const agent = await client.agents.retrieve(input.agentId);
    return agent.system ?? undefined;
  } catch {
    debugLog("memory", "Failed to fetch agent system prompt for reflection");
    return undefined;
  }
}

async function runReflectionLaunch(
  input: LaunchReflectionInput,
  onLaunched?: (result: LaunchReflectionLaunchedResult) => void,
): Promise<LaunchReflectionResult> {
  const {
    agentId,
    conversationId,
    workingDirectory,
    triggerSource,
    recompileContext,
  } = input;

  if (!agentId || !isMemfsEnabled(input)) {
    return trackSkippedLaunch(input, "memfs-disabled");
  }

  if (hasActiveReflectionSubagent(agentId, conversationId)) {
    debugLog(
      "memory",
      `Skipping auto reflection launch (${triggerSource}) because one is already active`,
    );
    return trackSkippedLaunch(input, "already-active");
  }

  const systemPrompt = await getSystemPrompt(input);
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

  const spawnBackgroundSubagentTask =
    input.deps?.spawnBackgroundSubagentTask ??
    defaultSpawnBackgroundSubagentTask;
  const waitForBackgroundSubagentAgentId =
    input.deps?.waitForBackgroundSubagentAgentId ??
    defaultWaitForBackgroundSubagentAgentId;

  let resolveCompletion: (result: LaunchReflectionCompletedResult) => void =
    () => {};
  const completionPromise = new Promise<LaunchReflectionCompletedResult>(
    (resolve) => {
      resolveCompletion = resolve;
    },
  );

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

        const completionMessage = await (
          input.deps?.handleMemorySubagentCompletion ??
          handleMemorySubagentCompletion
        )(
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
        resolveCompletion({
          status: "completed",
          success,
          payloadPath: autoPayload.payloadPath,
          subagentId,
          reflectionAgentId: reflectionAgentId ?? null,
          startMessageId: autoPayload.startMessageId,
          endMessageId: autoPayload.endMessageId,
        });
      }
    },
  });

  const reflectionAgentId = await waitForBackgroundSubagentAgentId(
    subagentId,
    SUBAGENT_ID_WAIT_MS,
  );
  telemetry.trackReflectionStart(triggerSource, {
    agentId,
    subagentId: reflectionAgentId ?? undefined,
    conversationId,
    startMessageId: autoPayload.startMessageId,
    endMessageId: autoPayload.endMessageId,
  });

  onLaunched?.({
    status: "launched",
    payloadPath: autoPayload.payloadPath,
    subagentId,
    reflectionAgentId,
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
  onLaunched?: (result: LaunchReflectionLaunchedResult) => void,
): Promise<LaunchReflectionResult> {
  return enqueueReflectionForAgent(input.agentId, () =>
    runReflectionLaunch(input, onLaunched),
  );
}

export async function launchReflectionSubagent(
  input: LaunchReflectionInput,
): Promise<LaunchReflectionResult> {
  if (!input.agentId || !isMemfsEnabled(input)) {
    return trackSkippedLaunch(input, "memfs-disabled");
  }
  // Pre-queue check for the user-facing "already running" signal. A queued
  // launch racing with this check is harmless: the per-agent queue is the
  // source of truth and serializes overlapping launches.
  if (hasActiveReflectionSubagent(input.agentId, input.conversationId)) {
    return trackSkippedLaunch(input, "already-active");
  }

  const waitUntil = getWaitUntil(input);
  if (waitUntil === "queued") {
    const queuedLaunch = enqueueReflectionLaunch(input);
    queuedLaunch.catch((error) => {
      debugWarn(
        "memory",
        `Failed to auto-launch reflection subagent (${input.triggerSource}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return { status: "queued" };
  }

  let resolveLaunched: (result: LaunchReflectionResult) => void = () => {};
  const launchedPromise = new Promise<LaunchReflectionResult>((resolve) => {
    resolveLaunched = resolve;
  });
  const queuedLaunch = enqueueReflectionLaunch(input, resolveLaunched);

  if (waitUntil === "launched") {
    try {
      const result = await Promise.race([launchedPromise, queuedLaunch]);
      return result;
    } catch (error) {
      debugWarn(
        "memory",
        `Failed to auto-launch reflection subagent (${input.triggerSource}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    return await queuedLaunch;
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to auto-launch reflection subagent (${input.triggerSource}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const __autoReflectionTestUtils = {
  resetReflectionQueue() {
    reflectionQueueByAgent.clear();
  },
  enqueueReflectionForAgent,
};
