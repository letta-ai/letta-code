import {
  type ChannelRouteBindingTarget,
  validateChannelRouteTargets,
  withChannelRouteBindingsLive,
} from "@/channels/service-route-bindings";
import type { CronPromptQueueItem, QueueRuntime } from "@/queue/queue-runtime";
import type { CronTask } from "./cron-file";

type CronChannelAdapterLookup = (
  channelId: string,
  accountId?: string,
) => { isRunning(): boolean } | null;

function getCronChannelRouteTargets(task: CronTask) {
  return (task.channel_targets ?? []).map((target) => ({
    channelId: target.channel_id,
    accountId: target.account_id,
    chatId: target.chat_id,
    threadId: null,
  }));
}

function assertCronChannelAdaptersRunning(
  targets: ChannelRouteBindingTarget[],
  getAdapter: CronChannelAdapterLookup,
): void {
  for (const target of targets) {
    if (!getAdapter(target.channelId, target.accountId)?.isRunning()) {
      throw new Error(
        `Channel account "${target.accountId ?? "default"}" is not running for ${target.channelId}.`,
      );
    }
  }
}

export function validateCronChannelTargets(
  task: CronTask,
  getAdapter: CronChannelAdapterLookup,
): void {
  const targets = validateChannelRouteTargets(getCronChannelRouteTargets(task));
  assertCronChannelAdaptersRunning(targets, getAdapter);
}

export function enqueueCronPromptWithChannelTargets(params: {
  queueRuntime: QueueRuntime;
  queueItem: Omit<CronPromptQueueItem, "id" | "enqueuedAt">;
  task: CronTask;
  conversationId: string;
  getAdapter: CronChannelAdapterLookup;
}): CronPromptQueueItem | null {
  const targets = validateChannelRouteTargets(
    getCronChannelRouteTargets(params.task),
  );
  if (targets.length === 0) {
    return params.queueRuntime.enqueue(
      params.queueItem,
    ) as CronPromptQueueItem | null;
  }

  assertCronChannelAdaptersRunning(targets, params.getAdapter);

  return withChannelRouteBindingsLive(
    targets,
    params.task.agent_id,
    params.conversationId,
    () =>
      params.queueRuntime.enqueue(
        params.queueItem,
      ) as CronPromptQueueItem | null,
    (queuedItem) => queuedItem === null,
  );
}
