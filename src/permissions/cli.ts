// src/permissions/cli.ts
// CLI-level permission overrides from command-line flags
// These take precedence over settings.json but not over enterprise managed policies

/**
 * CLI permission overrides that are set via --allowedTools and --disallowedTools flags.
 * These rules override settings.json permissions for the current session.
 */
class CliPermissions {
  private allowedTools: string[] = [];
  private disallowedTools: string[] = [];

  /**
   * Parse and set allowed tools from CLI flag
   * Format: "Bash,Read" or "Bash(npm install),Read(src/**)"
   */
  setAllowedTools(toolsString: string): void {
    this.allowedTools = this.parseToolList(toolsString);
  }

  /**
   * Parse and set disallowed tools from CLI flag
   * Format: "WebFetch,Bash(curl:*)"
   */
  setDisallowedTools(toolsString: string): void {
    this.disallowedTools = this.parseToolList(toolsString);
  }

  /**
   * Parse comma-separated tool list into individual patterns
   * Handles: "Bash,Read" and "Bash(npm install),Read(src/**)"
   *
   * Special handling:
   * - "Bash" without params becomes "Bash(:*)" to match all Bash commands
   * - "Read" without params becomes "Read" (matches all Read calls)
   */
  private parseToolList(toolsString: string): string[] {
    if (!toolsString) return [];

    const tools: string[] = [];
    let current = "";
    let depth = 0;

    // Parse comma-separated list, respecting parentheses
    for (let i = 0; i < toolsString.length; i++) {
      const char = toolsString[i];

      if (char === "(") {
        depth++;
        current += char;
      } else if (char === ")") {
        depth--;
        current += char;
      } else if (char === "," && depth === 0) {
        // Only split on commas outside parentheses
        if (current.trim()) {
          tools.push(this.normalizePattern(current.trim()));
        }
        current = "";
      } else {
        current += char;
      }
    }

    // Add the last tool
    if (current.trim()) {
      tools.push(this.normalizePattern(current.trim()));
    }

    return tools;
  }

  /**
   * Normalize a tool pattern.
   * - "Bash" becomes "Bash(:*)" to match all commands
   * - File tools (Read, Write, Edit, Glob, Grep) become "ToolName(**)" to match all files
   * - Tool patterns with parentheses stay as-is
   */
  private normalizePattern(pattern: string): string {
    // If pattern has parentheses, keep as-is
    if (pattern.includes("(")) {
      return pattern;
    }

    // Bash without parentheses needs wildcard to match all commands
    if (pattern === "Bash") {
      return "Bash(:*)";
    }

    // File tools need wildcard to match all files
    const fileTools = ["Read", "Write", "Edit", "Glob", "Grep"];
    if (fileTools.includes(pattern)) {
      return `${pattern}(**)`;
    }

    // All other bare tool names stay as-is
    return pattern;
  }

  /**
   * Get all allowed tool patterns
   */
  getAllowedTools(): string[] {
    return [...this.allowedTools];
  }

  /**
   * Get all disallowed tool patterns
   */
  getDisallowedTools(): string[] {
    return [...this.disallowedTools];
  }

  /**
   * Check if any CLI overrides are set
   */
  hasOverrides(): boolean {
    return this.allowedTools.length > 0 || this.disallowedTools.length > 0;
  }

  /**
   * Clear all CLI permission overrides
   */
  clear(): void {
    this.allowedTools = [];
    this.disallowedTools = [];
  }
}

// Singleton instance
export const cliPermissions = new CliPermissions();
