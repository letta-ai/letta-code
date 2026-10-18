import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { reflectionMemoryParentHasChanges } from "@/agent/memory-worktree";
import {
  type ReflectionArenaRun,
  type StartReflectionArenaRunOptions,
  startReflectionArenaRun,
} from "@/cli/helpers/reflection-arena";
import { shouldSuppressReflectionLaunch } from "@/cli/helpers/reflection-launcher";
import { buildAutoReflectionPayload } from "@/cli/helpers/reflection-transcript";
import { isAutoReflectionEnabled } from "@/reflection-settings";
import { debugLog } from "@/utils/debug";

export type LaunchReflectionArenaOptions = Omit<
  StartReflectionArenaRunOptions,
  "payload"
>;

export type LaunchReflectionArenaResult =
  | { launched: true; payloadPath: string; run: ReflectionArenaRun }
  | {
      launched: false;
      reason:
        | "windows_disabled"
        | "configuration_error"
        | "no_payload"
        | "parent_dirty";
    };

export async function launchReflectionArena(
  options: LaunchReflectionArenaOptions,
): Promise<LaunchReflectionArenaResult> {
  if (options.triggerSource !== "manual" && !isAutoReflectionEnabled()) {
    return { launched: false, reason: "windows_disabled" };
  }
  if (shouldSuppressReflectionLaunch(options.agentId, options.triggerSource)) {
    return { launched: false, reason: "configuration_error" };
  }

  const memoryDir = getScopedMemoryFilesystemRoot(options.agentId);
  if (await reflectionMemoryParentHasChanges(memoryDir)) {
    debugLog(
      "memory",
      `Skipping reflection arena launch (${options.triggerSource}) because parent memory has uncommitted changes`,
    );
    return { launched: false, reason: "parent_dirty" };
  }

  const payload = await buildAutoReflectionPayload(
    options.agentId,
    options.conversationId,
  );
  if (!payload) {
    return { launched: false, reason: "no_payload" };
  }

  const run = await startReflectionArenaRun({
    ...options,
    payload,
  });
  return { launched: true, payloadPath: payload.payloadPath, run };
}
