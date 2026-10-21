import { isLettaCloud } from "@/agent/memory-filesystem";
import { getBackend } from "@/backend";
import {
  updateCloudReflectionConfig,
  updateCloudReflectionConversationProgress,
} from "@/backend/api/reflection";
import {
  getReflectionSettings,
  type ReflectionSettings,
} from "@/cli/helpers/memory-reminder";
import {
  finalizeAutoReflectionPayload,
  finalizeMultiReflectionPayload,
  type MultiReflectionManifest,
} from "@/cli/helpers/reflection-transcript";
import { debugWarn } from "@/utils/debug";

export interface ReflectionCompletionCheckpoint {
  conversationId: string;
  reflectedThroughMessageId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logCloudSyncWarning(message: string): void {
  debugWarn("memory", message);
}

async function isCloudReflectionAgent(): Promise<boolean> {
  const backend = getBackend();
  return (
    backend.capabilities.remoteMemfs &&
    !backend.capabilities.localMemfs &&
    (await isLettaCloud())
  );
}

export async function syncReflectionCompletionToCloud(
  params: {
    agentId: string;
    checkpoints: ReflectionCompletionCheckpoint[];
  },
  dependencies: {
    isCloud?: () => Promise<boolean>;
    getSettings?: (agentId: string) => ReflectionSettings;
    updateConfig?: typeof updateCloudReflectionConfig;
    updateProgress?: typeof updateCloudReflectionConversationProgress;
    logWarning?: (message: string) => void;
  } = {},
): Promise<void> {
  const logWarning = dependencies.logWarning ?? logCloudSyncWarning;
  try {
    if (!(await (dependencies.isCloud ?? isCloudReflectionAgent)())) {
      return;
    }
  } catch (error) {
    logWarning(
      `Failed to detect Cloud reflection state: ${errorMessage(error)}`,
    );
    return;
  }

  let settings: ReflectionSettings;
  try {
    settings = (dependencies.getSettings ?? getReflectionSettings)(
      params.agentId,
    );
  } catch (error) {
    logWarning(
      `Failed to resolve Cloud reflection config: ${errorMessage(error)}`,
    );
    return;
  }
  try {
    await (dependencies.updateConfig ?? updateCloudReflectionConfig)(
      params.agentId,
      {
        enabled: settings.trigger !== "off",
        min_turn_count: settings.stepCount,
      },
    );
  } catch (error) {
    logWarning(
      `Failed to sync Cloud reflection config: ${errorMessage(error)}`,
    );
    return;
  }

  for (const checkpoint of params.checkpoints) {
    try {
      await (
        dependencies.updateProgress ?? updateCloudReflectionConversationProgress
      )(params.agentId, checkpoint.conversationId, {
        reflected_through_message_id: checkpoint.reflectedThroughMessageId,
      });
    } catch (error) {
      logWarning(
        `Failed to sync Cloud reflection progress for ${checkpoint.conversationId}: ${errorMessage(error)}`,
      );
    }
  }
}

export async function finalizeAutoReflectionCompletion(
  agentId: string,
  conversationId: string,
  payloadPath: string,
  endSnapshotLine: number,
  reflectedThroughMessageId: string | undefined,
  success: boolean,
): Promise<void> {
  await finalizeAutoReflectionPayload(
    agentId,
    conversationId,
    payloadPath,
    endSnapshotLine,
    success,
  );
  if (!success) {
    return;
  }

  await syncReflectionCompletionToCloud({
    agentId,
    checkpoints: reflectedThroughMessageId
      ? [{ conversationId, reflectedThroughMessageId }]
      : [],
  });
}

export async function finalizeMultiReflectionCompletion(
  agentId: string,
  manifest: MultiReflectionManifest,
  success: boolean,
): Promise<void> {
  await finalizeMultiReflectionPayload(agentId, manifest, success);
  if (!success) {
    return;
  }

  await syncReflectionCompletionToCloud({
    agentId,
    checkpoints: manifest.transcripts
      .filter((slice) => slice.mode === "unreflected")
      .map((slice) => ({
        conversationId: slice.conversation_id,
        reflectedThroughMessageId: slice.end_message_id,
      })),
  });
}
