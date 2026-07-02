// src/permissions/cli.ts
// CLI-level permission overrides from command-line flags
// These take precedence over settings.json but not over enterprise managed policies

import {
  canonicalToolName,
  isFileToolName,
  isShellToolName,
} from "./canonical";

import { normalizePermissionRule } from "./rule-normalization";

/**
 * CLI permission overrides that are set via --allowedTools and --disallowedTools flags.
 * These rules override settings.json permissions for the current session.
 */
export class CliPermissions {
  private allowedTools: string[] = [];
  private disallowedTools: string[] = [];
  private memoryGuardDisabled = false;

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
   * Disable the cross-agent memory guard for this parent CLI process. Parent
   * processes start guarded by default; this is only set by the explicit
   * --disable-memory-guard override. Subagent processes ignore this setting
   * when evaluating the guard.
   */
  setMemoryGuardDisabled(disabled: boolean): void {
    this.memoryGuardDisabled = disabled;
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
   * Whether --disable-memory-guard was set on the CLI.
   */
  isMemoryGuardDisabled(): boolean {
    return this.memoryGuardDisabled;
  }

  /**
   * Clear all CLI permission overrides
   */
  clear(): void {
    this.allowedTools = [];
    this.disallowedTools = [];
    this.memoryGuardDisabled = false;
  }
}
