/**
 * Agent context module - provides global access to current agent state
 * This allows tools to access the current agent ID without threading it through params.
 */

interface AgentContext {
  agentId: string | null;
  skillsDirectory: string | null;
  hasLoadedSkills: boolean;
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
      hasLoadedSkills: false,
    };
  }
  return global[CONTEXT_KEY];
}

const context = getContext();

/**
 * Set the current agent context
 * @param agentId - The agent ID
 * @param skillsDirectory - Optional skills directory path
 */
export function setAgentContext(
  agentId: string,
  skillsDirectory?: string,
): void {
  context.agentId = agentId;
  context.skillsDirectory = skillsDirectory || null;
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
 * Check if skills are currently loaded (cached state)
 * @returns true if skills are loaded, false otherwise
 */
export function hasLoadedSkills(): boolean {
  return context.hasLoadedSkills;
}

/**
 * Update the loaded skills state (called by Skill tool)
 * @param loaded - Whether skills are currently loaded
 */
export function setHasLoadedSkills(loaded: boolean): void {
  context.hasLoadedSkills = loaded;
}

/**
 * Initialize the loaded skills flag by checking the block
 * Should be called after setAgentContext to sync the cached state
 */
export async function initializeLoadedSkillsFlag(): Promise<void> {
  if (!context.agentId) {
    return;
  }

  try {
    const { getClient } = await import("./client");
    const client = await getClient();
    const loadedSkillsBlock = await client.agents.blocks.retrieve(
      "loaded_skills",
      { agent_id: context.agentId },
    );
    const value = loadedSkillsBlock?.value?.trim() || "";
    // Consider empty or placeholder as no skills loaded
    context.hasLoadedSkills = value !== "" && value !== "[CURRENTLY EMPTY]";
  } catch {
    // Block doesn't exist, no skills loaded
    context.hasLoadedSkills = false;
  }
}
