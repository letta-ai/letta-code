import { getRuntimeContext, updateRuntimeContext } from "@/runtime-context";
import { ALL_SKILL_SOURCES } from "./skill-sources";
import type { SkillSource } from "./skills";

interface AgentContext {
  agentId: string | null;
  agentName: string | null;
  skillsDirectory: string | null;
  skillSources: SkillSource[];
  conversationId: string | null;
}

const CONTEXT_KEY = Symbol.for("@letta/agentContext");

type GlobalWithContext = typeof globalThis & {
  [key: symbol]: AgentContext;
};

function getContext(): AgentContext {
  const global = globalThis as GlobalWithContext;
  if (!global[CONTEXT_KEY]) {
    global[CONTEXT_KEY] = {
      agentId: null,
      agentName: null,
      skillsDirectory: null,
      skillSources: [...ALL_SKILL_SOURCES],
      conversationId: null,
    };
  }
  return global[CONTEXT_KEY];
}

const context = getContext();

export function setAgentContext(
  agentId: string,
  skillsDirectory?: string,
  skillSources?: SkillSource[],
  agentName?: string | null,
): void {
  context.agentId = agentId;
  context.agentName = normalizeAgentName(agentName);
  context.skillsDirectory = skillsDirectory || null;
  context.skillSources =
    skillSources !== undefined ? [...skillSources] : [...ALL_SKILL_SOURCES];
  if (getRuntimeContext()) {
    updateRuntimeContext({
      agentId,
      agentName: context.agentName,
      skillsDirectory: skillsDirectory || null,
      skillSources:
        skillSources !== undefined ? [...skillSources] : [...ALL_SKILL_SOURCES],
    });
  }
}

export function setCurrentAgentId(agentId: string | null): void {
  const agentChanged = context.agentId !== agentId;
  context.agentId = agentId;
  if (agentId === null || agentChanged) {
    context.agentName = null;
  }
  if (getRuntimeContext()) {
    updateRuntimeContext({
      agentId,
      ...(agentId === null || agentChanged ? { agentName: null } : {}),
    });
  }
}

export function setCurrentAgentName(agentName: string | null): void {
  context.agentName = normalizeAgentName(agentName);
  if (getRuntimeContext()) {
    updateRuntimeContext({ agentName: context.agentName });
  }
}

function normalizeAgentName(
  agentName: string | null | undefined,
): string | null {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return trimmed || null;
}

export function getCurrentAgentId(): string {
  const runtimeContext = getRuntimeContext();
  if (runtimeContext && "agentId" in runtimeContext) {
    if (runtimeContext.agentId) {
      return runtimeContext.agentId;
    }
    throw new Error("No agent context set. Agent ID is required.");
  }
  if (!context.agentId) {
    throw new Error("No agent context set. Agent ID is required.");
  }
  return context.agentId;
}

export function getCurrentAgentName(): string | null {
  const runtimeContext = getRuntimeContext();
  if (runtimeContext && "agentName" in runtimeContext) {
    const trimmed = runtimeContext.agentName?.trim();
    return trimmed || null;
  }
  return context.agentName;
}

export function getSkillsDirectory(): string | null {
  const runtimeContext = getRuntimeContext();
  if (runtimeContext && "skillsDirectory" in runtimeContext) {
    return runtimeContext.skillsDirectory ?? null;
  }
  return context.skillsDirectory;
}

export function getBundledSkillAllowlist(): string[] | undefined {
  const bundledSkills = getRuntimeContext()?.bundledSkills;
  return bundledSkills ? [...bundledSkills] : undefined;
}

export function getSkillSources(): SkillSource[] {
  const runtimeContext = getRuntimeContext();
  if (runtimeContext?.skillSources) {
    return [...runtimeContext.skillSources];
  }
  return [...context.skillSources];
}

export function setConversationId(conversationId: string | null): void {
  context.conversationId = conversationId;
  if (getRuntimeContext()) {
    updateRuntimeContext({ conversationId });
  }
}

export function getConversationId(): string | null {
  const runtimeContext = getRuntimeContext();
  if (runtimeContext && "conversationId" in runtimeContext) {
    return runtimeContext.conversationId ?? null;
  }
  return context.conversationId;
}
