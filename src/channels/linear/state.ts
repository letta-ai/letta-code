import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getChannelDir } from "@/channels/config";
import { isRecord } from "@/utils/type-guards";

const STATE_VERSION = 1;
export const MAX_LINEAR_SEEN_NOTIFICATIONS = 2000;

export interface LinearPollState {
  version: 1;
  initializedAt: string | null;
  seenNotificationIds: string[];
}

export interface LinearPollStateStore {
  load(): LinearPollState;
  save(state: LinearPollState): void;
}

export function createEmptyLinearPollState(): LinearPollState {
  return {
    version: STATE_VERSION,
    initializedAt: null,
    seenNotificationIds: [],
  };
}

export function normalizeLinearPollState(value: unknown): LinearPollState {
  if (
    !isRecord(value) ||
    value.version !== STATE_VERSION ||
    !Array.isArray(value.seenNotificationIds)
  ) {
    return createEmptyLinearPollState();
  }
  return {
    version: STATE_VERSION,
    initializedAt:
      typeof value.initializedAt === "string" ? value.initializedAt : null,
    seenNotificationIds: value.seenNotificationIds
      .filter((id): id is string => typeof id === "string")
      .slice(-MAX_LINEAR_SEEN_NOTIFICATIONS),
  };
}

export function createLinearPollStateStore(
  accountId: string,
): LinearPollStateStore {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const directory = getChannelDir("linear");
  const path = join(directory, `poll-state.${safeAccountId}.json`);

  return {
    load() {
      if (!existsSync(path)) return createEmptyLinearPollState();
      try {
        return normalizeLinearPollState(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return createEmptyLinearPollState();
      }
    },

    save(state) {
      mkdirSync(directory, { recursive: true });
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, path);
    },
  };
}
