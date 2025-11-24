/**
 * Agent context for tool execution
 *
 * This module provides a global context that tools can access to get
 * information about the currently executing agent.
 */

interface AgentContext {
  agentId: string | null;
  workingDirectory: string;
}

// Use globalThis to ensure singleton across bundle
const CONTEXT_KEY = Symbol.for("@letta/agentContext");

type GlobalWithContext = typeof globalThis & {
  [key: symbol]: AgentContext;
};

function getContext(): AgentContext {
  const global = globalThis as GlobalWithContext;
  if (!global[CONTEXT_KEY]) {
    global[CONTEXT_KEY] = {
      agentId: null,
      workingDirectory: process.cwd(),
    };
  }
  return global[CONTEXT_KEY];
}

/**
 * Set the current agent ID in context
 */
export function setCurrentAgentId(agentId: string): void {
  const context = getContext();
  context.agentId = agentId;
}

/**
 * Get the current agent ID from context
 */
export function getCurrentAgentId(): string | null {
  const context = getContext();
  return context.agentId;
}

/**
 * Clear the current agent context
 */
export function clearAgentContext(): void {
  const context = getContext();
  context.agentId = null;
}

/**
 * Set the working directory in context
 */
export function setWorkingDirectory(directory: string): void {
  const context = getContext();
  context.workingDirectory = directory;
}

/**
 * Get the working directory from context
 */
export function getWorkingDirectory(): string {
  const context = getContext();
  return context.workingDirectory;
}
