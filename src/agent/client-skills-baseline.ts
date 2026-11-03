/**
 * Per-conversation `client_skills` baseline.
 *
 * The server renders `client_skills` into the prompt prefix on every request,
 * so any change to it invalidates the provider prompt cache and drops earlier
 * thinking blocks. Each conversation scope therefore keeps a frozen payload
 * that is sent on every request. Later catalog changes reach the model only
 * through a skill-delta reminder, diffed against `announced` (the frozen list
 * plus deltas already delivered). A compaction rewrites the conversation
 * history anyway, which also drops earlier reminders, so it re-baselines:
 * the next request sends the current catalog as the new frozen list.
 *
 * Baselines live in memory only. After a process restart, the first request
 * per conversation sends the current catalog as a fresh baseline (at most one
 * cache bust if the catalog changed while the process was down).
 */

import type { Backend } from "@/backend";
import { onConversationCompacted } from "@/backend/compaction-events";
import {
  type BuildClientSkillsPayloadResult,
  buildClientSkillsUpdateReminder,
} from "./client-skills";

type ClientSkillsPayload = BuildClientSkillsPayloadResult["clientSkills"];

type ClientSkillsBaseline = {
  frozen: ClientSkillsPayload;
  announced: ClientSkillsPayload;
  rebaseline: boolean;
};

export type ClientSkillsScope = {
  conversationId: string;
  agentId?: string | null;
};

export type ClientSkillsRequestPlan = {
  /** The payload to send as `client_skills`. */
  clientSkills: ClientSkillsPayload;
  /** A skill-delta reminder to append to this request, if the catalog changed. */
  reminder: string | null;
  /**
   * Record the request as accepted. Call only after the server accepts it,
   * so a rejected request does not consume the reminder. Returns a callback
   * for compaction seen on this request's stream; it ignores a late summary
   * from a stream that a newer accepted request has superseded.
   */
  accept(): () => void;
};

// Backend identity and agent/default-conversation scope must not share a
// baseline. Discovery cache invalidation must not clear it either.
const baselinesByBackend = new WeakMap<
  object,
  Map<string, ClientSkillsBaseline>
>();

// Manual compacts and resumed streams are reported by the backend.
onConversationCompacted(({ backend, conversationId, agentId }) =>
  markClientSkillsCompacted(backend, { conversationId, agentId }),
);

function getBaselines(backend: Backend): Map<string, ClientSkillsBaseline> {
  let baselines = baselinesByBackend.get(backend);
  if (!baselines) {
    baselines = new Map();
    baselinesByBackend.set(backend, baselines);
  }
  return baselines;
}

function scopeKey({ conversationId, agentId }: ClientSkillsScope): string {
  // Non-default conversation ids are globally unique; the default
  // conversation is per agent.
  return conversationId === "default" && agentId
    ? `${conversationId}:${agentId}`
    : conversationId;
}

export function planClientSkillsRequest(
  backend: Backend,
  scope: ClientSkillsScope,
  current: ClientSkillsPayload,
): ClientSkillsRequestPlan {
  const baselines = getBaselines(backend);
  const key = scopeKey(scope);
  const baseline = baselines.get(key);
  if (!baseline || baseline.rebaseline) {
    return {
      clientSkills: current,
      reminder: null,
      accept: () =>
        acceptBaseline(baselines, key, {
          frozen: current,
          announced: current,
          rebaseline: false,
        }),
    };
  }
  return {
    clientSkills: baseline.frozen,
    reminder: buildClientSkillsUpdateReminder(baseline.announced, current),
    accept: () =>
      acceptBaseline(baselines, key, { ...baseline, announced: current }),
  };
}

function acceptBaseline(
  baselines: Map<string, ClientSkillsBaseline>,
  key: string,
  accepted: ClientSkillsBaseline,
): () => void {
  baselines.set(key, accepted);
  return () => {
    if (baselines.get(key) === accepted) accepted.rebaseline = true;
  };
}

/**
 * Re-baseline after a compaction observed outside this request's send stream
 * (manual compact, or a resumed stream). The next request sends the current
 * catalog as the new frozen list.
 */
function markClientSkillsCompacted(
  backend: object,
  scope: ClientSkillsScope,
): void {
  const baseline = baselinesByBackend.get(backend)?.get(scopeKey(scope));
  if (baseline) baseline.rebaseline = true;
}
