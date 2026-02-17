/**
 * Agent context module - provides global access to current agent state
 * This allows tools to access the current agent ID without threading it through params.
 */

import { ALL_SKILL_SOURCES } from "./skillSources";
import type { SkillSource } from "./skills";

interface AgentContext {
  agentId: string | null;
  skillsDirectory: string | null;
  skillSources: SkillSource[];
  conversationId: string | null;
}

// Use globalThis to ensure singleton across bundle
// This prevents Bun's bundler from creating duplicate instances of the context
const CONTEXT_KEY = Symbol.for("@letta/agentContext");

type GlobalWithContext = typeof globalThis & {
  [key: symbol]: AgentContext;
};

function getContext(): AgentContext {
  const global = globalThis as GlobalWithContext;
  if (!global[CONTEXT_KEY]) {
    global[CONTEXT_KEY] = {
      agentId: null,
      skillsDirectory: null,
      skillSources: [...ALL_SKILL_SOURCES],
      conversationId: null,
    };
  }
  return global[CONTEXT_KEY];
}

const context = getContext();

/**
 * Set the current agent context
 * @param agentId - The agent ID
 * @param skillsDirectory - Optional skills directory path
 * @param skillSources - Enabled skill sources for this session
 */
export function setAgentContext(
  agentId: string,
  skillsDirectory?: string,
  skillSources?: SkillSource[],
): void {
  context.agentId = agentId;
  context.skillsDirectory = skillsDirectory || null;
  context.skillSources =
    skillSources !== undefined ? [...skillSources] : [...ALL_SKILL_SOURCES];
}

/**
 * Set the current agent ID in context (simplified version for compatibility)
 */
export function setCurrentAgentId(agentId: string): void {
  context.agentId = agentId;
}

/**
 * Get the current agent ID
 * @throws Error if no agent context is set
 */
export function getCurrentAgentId(): string {
  if (!context.agentId) {
    throw new Error("No agent context set. Agent ID is required.");
  }
  return context.agentId;
}

/**
 * Get the skills directory path
 * @returns The skills directory path or null if not set
 */
export function getSkillsDirectory(): string | null {
  return context.skillsDirectory;
}

/**
 * Get enabled skill sources for discovery/injection.
 */
export function getSkillSources(): SkillSource[] {
  return [...context.skillSources];
}

/**
 * Backwards-compat helper: returns true when bundled skills are disabled.
 */
export function getNoSkills(): boolean {
  return !context.skillSources.includes("bundled");
}

/**
 * Set the current conversation ID
 * @param conversationId - The conversation ID, or null to clear
 */
export function setConversationId(conversationId: string | null): void {
  context.conversationId = conversationId;
}

/**
 * Get the current conversation ID
 * @returns The conversation ID or null if not set
 */
export function getConversationId(): string | null {
  return context.conversationId;
}
