export interface DiscordObserverTarget {
  /** Dedicated observer agent that receives each flushed Discord batch. */
  agentId: string;
  /** Fixed persistent conversation for this observer agent. */
  conversationId: string;
}

export interface DiscordObserverConfig {
  /** Discord guild to observe. Other guilds continue through normal routing. */
  guildId: string;
  /** Every batch is fanned out to each fixed agent conversation. */
  targets: DiscordObserverTarget[];
  /** Tumbling batch interval. Defaults to ten minutes. */
  flushIntervalMs?: number;
  /** Flush early at this many messages. */
  maxMessages?: number;
  /** Flush early when serialized message text reaches this many characters. */
  maxCharacters?: number;
  /** Include foreign bot messages. Self-authored messages are always dropped. */
  includeBots?: boolean;
}

export const DISCORD_OBSERVER_MIN_FLUSH_INTERVAL_MS = 1_000;
export const DISCORD_OBSERVER_MAX_FLUSH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const DISCORD_OBSERVER_MAX_MESSAGES = 10_000;
export const DISCORD_OBSERVER_MAX_CHARACTERS = 10_000_000;

function isBoundedPositiveInteger(
  value: unknown,
  maximum: number,
  minimum = 1,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

export function isDiscordObserverConfig(
  value: unknown,
): value is DiscordObserverConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const observer = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "guildId",
    "targets",
    "flushIntervalMs",
    "maxMessages",
    "maxCharacters",
    "includeBots",
  ]);
  if (Object.keys(observer).some((key) => !allowedKeys.has(key))) return false;
  if (typeof observer.guildId !== "string" || observer.guildId.length === 0) {
    return false;
  }
  if (
    !Array.isArray(observer.targets) ||
    observer.targets.length === 0 ||
    observer.targets.length > 32 ||
    !observer.targets.every((target) => {
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        return false;
      }
      const record = target as Record<string, unknown>;
      return (
        Object.keys(record).every(
          (key) => key === "agentId" || key === "conversationId",
        ) &&
        typeof record.agentId === "string" &&
        record.agentId.length > 0 &&
        typeof record.conversationId === "string" &&
        record.conversationId.length > 0
      );
    })
  ) {
    return false;
  }
  return (
    (observer.flushIntervalMs === undefined ||
      isBoundedPositiveInteger(
        observer.flushIntervalMs,
        DISCORD_OBSERVER_MAX_FLUSH_INTERVAL_MS,
        DISCORD_OBSERVER_MIN_FLUSH_INTERVAL_MS,
      )) &&
    (observer.maxMessages === undefined ||
      isBoundedPositiveInteger(
        observer.maxMessages,
        DISCORD_OBSERVER_MAX_MESSAGES,
      )) &&
    (observer.maxCharacters === undefined ||
      isBoundedPositiveInteger(
        observer.maxCharacters,
        DISCORD_OBSERVER_MAX_CHARACTERS,
      )) &&
    (observer.includeBots === undefined ||
      typeof observer.includeBots === "boolean")
  );
}

export function cloneDiscordObserverConfig(
  observer: DiscordObserverConfig,
): DiscordObserverConfig {
  return {
    ...observer,
    targets: observer.targets.map((target) => ({ ...target })),
  };
}

export function normalizeDiscordObserverConfig(
  value: unknown,
): DiscordObserverConfig | undefined {
  return isDiscordObserverConfig(value)
    ? cloneDiscordObserverConfig(value)
    : undefined;
}
