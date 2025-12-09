// src/tools/filter.ts
// Tool filtering - controls which tools are loaded and registered with the agent

/**
 * Tool filter manager to control which tools are enabled for the session.
 * Set via CLI --tools flag.
 */
class ToolFilterManager {
  private enabledTools: string[] | null = null; // null = all tools enabled

  /**
   * Set which tools are enabled for this session
   * @param toolsString - Comma-separated list of tool names, or empty string for no tools
   */
  setEnabledTools(toolsString: string): void {
    if (toolsString === "") {
      // Empty string means no tools
      this.enabledTools = [];
    } else {
      // Parse comma-separated tool names
      this.enabledTools = toolsString
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
  }

  /**
   * Check if a tool is enabled
   * @param toolName - Name of the tool to check
   * @returns true if the tool should be loaded, false otherwise
   */
  isEnabled(toolName: string): boolean {
    // If no filter set (null), all tools are enabled
    if (this.enabledTools === null) {
      return true;
    }

    // Check if tool is in the enabled list
    return this.enabledTools.includes(toolName);
  }

  /**
   * Get list of enabled tools (null means all tools)
   */
  getEnabledTools(): string[] | null {
    return this.enabledTools ? [...this.enabledTools] : null;
  }

  /**
   * Check if filter is active (i.e., not all tools enabled)
   */
  isActive(): boolean {
    return this.enabledTools !== null;
  }

  /**
   * Reset to default (all tools enabled)
   */
  reset(): void {
    this.enabledTools = null;
  }
}

// Use globalThis to ensure singleton across bundle
// This prevents Bun's bundler from creating duplicate instances
const FILTER_KEY = Symbol.for("@letta/toolFilter");

type GlobalWithFilter = typeof globalThis & {
  [key: symbol]: ToolFilterManager;
};

function getFilter(): ToolFilterManager {
  const global = globalThis as GlobalWithFilter;
  if (!global[FILTER_KEY]) {
    global[FILTER_KEY] = new ToolFilterManager();
  }
  return global[FILTER_KEY];
}

export const toolFilter = getFilter();
