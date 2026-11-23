import type { Backend } from "@/backend";
import { onConversationCompacted } from "@/backend/compaction-events";
import {
  type BuildClientSkillsPayloadResult,
  buildClientSkillsUpdateReminder,
} from "./client-skills";
import {
  loadClientSkillsBaseline,
  saveClientSkillsBaseline,
} from "./client-skills-baseline-store";

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
  clientSkills: ClientSkillsPayload;
  reminder: string | null;
  accept(): () => void;
};

let baselinesByBackend = new WeakMap<
  object,
  Map<string, ClientSkillsBaseline>
>();

onConversationCompacted(({ backend, conversationId, agentId }) =>
  markClientSkillsCompacted(backend, { conversationId, agentId }),
);

function getBaselines(backend: object): Map<string, ClientSkillsBaseline> {
  let baselines = baselinesByBackend.get(backend);
  if (!baselines) {
    baselines = new Map();
    baselinesByBackend.set(backend, baselines);
  }
  return baselines;
}

function scopeKey({ conversationId, agentId }: ClientSkillsScope): string {
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
  const baseline = getOrLoadBaseline(backend, baselines, key);
  if (!baseline || baseline.rebaseline) {
    return {
      clientSkills: current,
      reminder: null,
      accept: () =>
        acceptBaseline(backend, baselines, key, {
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
      acceptBaseline(backend, baselines, key, {
        ...baseline,
        announced: current,
      }),
  };
}

function getOrLoadBaseline(
  backend: object,
  baselines: Map<string, ClientSkillsBaseline>,
  key: string,
): ClientSkillsBaseline | undefined {
  let baseline = baselines.get(key);
  if (!baseline) {
    baseline = loadClientSkillsBaseline(backend, key) ?? undefined;
    if (baseline) baselines.set(key, baseline);
  }
  return baseline;
}

function acceptBaseline(
  backend: object,
  baselines: Map<string, ClientSkillsBaseline>,
  key: string,
  accepted: ClientSkillsBaseline,
): () => void {
  baselines.set(key, accepted);
  saveClientSkillsBaseline(backend, key, accepted);
  return () => {
    if (baselines.get(key) === accepted) markRebaseline(backend, key, accepted);
  };
}

function markRebaseline(
  backend: object,
  key: string,
  baseline: ClientSkillsBaseline,
): void {
  if (baseline.rebaseline) return;
  baseline.rebaseline = true;
  saveClientSkillsBaseline(backend, key, baseline);
}

function markClientSkillsCompacted(
  backend: object,
  scope: ClientSkillsScope,
): void {
  const key = scopeKey(scope);
  const baseline = getOrLoadBaseline(backend, getBaselines(backend), key);
  if (baseline) markRebaseline(backend, key, baseline);
}

export function resetClientSkillsBaselinesForTests(): void {
  baselinesByBackend = new WeakMap();
}
