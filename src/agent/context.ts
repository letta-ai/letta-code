/**
 * Agent context module - provides global access to current agent state
 * This allows tools to access the current agent ID and client
 */

import type Letta from "@letta-ai/letta-client";

interface AgentContext {
  agentId: string | null;
  client: Letta | null;
  skillsDirectory: string | null;
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
      client: null,
      skillsDirectory: null,
    };
  }
  return global[CONTEXT_KEY];
}

const context = getContext();

/**
 * Set the current agent context
 * @param agentId - The agent ID
 * @param client - The Letta client instance
 * @param skillsDirectory - Optional skills directory path
 */
export function setAgentContext(
  agentId: string,
  client: Letta,
  skillsDirectory?: string,
): void {
  context.agentId = agentId;
  context.client = client;
  context.skillsDirectory = skillsDirectory || null;
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
 * Get the current Letta client
 * @throws Error if no agent context is set
 */
export function getCurrentClient(): Letta {
  if (!context.client) {
    throw new Error("No agent context set. Client is required.");
  }
  return context.client;
}

/**
 * Get the skills directory path
 * @returns The skills directory path or null if not set
 */
export function getSkillsDirectory(): string | null {
  return context.skillsDirectory;
}

/**
 * Clear the agent context (useful for cleanup)
 */
export function clearAgentContext(): void {
  context.agentId = null;
  context.client = null;
  context.skillsDirectory = null;
}
