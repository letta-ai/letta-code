import type { ModEvents } from "@/mods/event-emitter";

type ListenerBackgroundRegistration = {
  createNotificationGuard: () =>
    | ListenerExternalToolNotificationGuard
    | undefined;
  /** Optional foreground wait override; listener registrations use 10 seconds. */
  yieldMs?: number;
};

export type ListenerExternalToolNotificationGuard = {
  isCurrent: () => boolean;
  waitUntilCurrent: () => Promise<boolean>;
};

const listenerRegistrations = new WeakMap<
  object,
  ListenerBackgroundRegistration
>();

/** Mark an in-process listener tool as eligible for task notification delivery. */
export function enableListenerExternalToolBackground<T extends object>(
  tool: T,
  options: ListenerBackgroundRegistration,
): T {
  listenerRegistrations.set(tool, options);
  return tool;
}

function hasActiveToolEndHandlers(events: ModEvents | undefined): boolean {
  if (!events) return false;
  return events.hasHandlers?.("tool_end") ?? true;
}

export function listenerExternalToolBackgroundOptions(
  tool: object | undefined,
  events: ModEvents | undefined,
  runtimeScope: {
    agentId?: string | null;
    conversationId?: string | null;
    actingUserId?: string;
    suppressActingUserFallback?: boolean;
  },
): {
  runtimeScope: typeof runtimeScope;
  canBackground: () => boolean;
  yieldMs?: number;
  shouldEnqueue?: () => Promise<boolean>;
} {
  const registration = tool ? listenerRegistrations.get(tool) : undefined;
  const notificationGuard = registration?.createNotificationGuard();
  return {
    canBackground: () =>
      notificationGuard?.isCurrent() === true &&
      !hasActiveToolEndHandlers(events),
    ...(registration?.yieldMs !== undefined
      ? { yieldMs: registration.yieldMs }
      : {}),
    ...(notificationGuard
      ? { shouldEnqueue: notificationGuard.waitUntilCurrent }
      : {}),
    runtimeScope,
  };
}
