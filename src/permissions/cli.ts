// src/permissions/cli.ts
// CLI-level permission overrides from command-line flags
// These take precedence over settings.json but not over enterprise managed policies

import {
  canonicalToolName,
  isFileToolName,
  isShellToolName,
} from "./canonical";
import { parseScopeList } from "./memoryScope";
import { normalizePermissionRule } from "./rule-normalization";

/**
 * CLI permission overrides that are set via --allowedTools and --disallowedTools flags.
 * These rules override settings.json permissions for the current session.
 */
class CliPermissions {
  private allowedTools: string[] = [];
  private disallowedTools: string[] = [];
  private memoryScope: string[] = [];

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
   * Parse and set the memory-scope flag — a list of agent IDs whose memory
   * this session is allowed to access (in addition to the current agent).
   * Format: comma- or whitespace-separated agent IDs, e.g.
   *   --memory-scope "agent-abc, agent-def"
   *   --memory-scope "agent-abc agent-def"
   */
  setMemoryScope(scopeString: string): void {
    this.memoryScope = parseScopeList(scopeString);
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
    const trimmed = pattern.trim();

    // If pattern has parentheses, keep as-is
    if (trimmed.includes("(")) {
      return normalizePermissionRule(trimmed);
    }

    const canonicalTool = canonicalToolName(trimmed);

    // Bash/shell aliases without parentheses need wildcard to match all commands
    if (isShellToolName(canonicalTool)) {
      return "Bash(:*)";
    }

    // File tools need wildcard to match all files
    if (isFileToolName(canonicalTool)) {
      return `${canonicalTool}(**)`;
    }

    // All other bare tool names stay as-is
    return canonicalTool;
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
   * Get the CLI-supplied memory-scope list (agent IDs).
   */
  getMemoryScope(): string[] {
    return [...this.memoryScope];
  }

  /**
   * Whether --memory-scope was set on the CLI.
   */
  hasMemoryScope(): boolean {
    return this.memoryScope.length > 0;
  }

  /**
   * Check if any CLI overrides are set
   */
  hasOverrides(): boolean {
    return (
      this.allowedTools.length > 0 ||
      this.disallowedTools.length > 0 ||
      this.memoryScope.length > 0
    );
  }

  /**
   * Clear all CLI permission overrides
   */
  clear(): void {
    this.allowedTools = [];
    this.disallowedTools = [];
    this.memoryScope = [];
  }
}

// Singleton instance
export const cliPermissions = new CliPermissions();
