import { getRuntimeContext } from "@/runtime-context";
import {
  canonicalToolName,
  isFileToolName,
  isShellToolName,
} from "./canonical";

import { normalizePermissionRule } from "./rule-normalization";

export class CliPermissions {
  private allowedTools: string[] = [];
  private disallowedTools: string[] = [];
  private memoryGuardDisabled = false;

  setAllowedTools(toolsString: string): void {
    this.allowedTools = this.parseToolList(toolsString);
  }

  setDisallowedTools(toolsString: string): void {
    this.disallowedTools = this.parseToolList(toolsString);
  }

  setMemoryGuardDisabled(disabled: boolean): void {
    this.memoryGuardDisabled = disabled;
  }

  private parseToolList(toolsString: string): string[] {
    if (!toolsString) return [];

    const tools: string[] = [];
    let current = "";
    let depth = 0;

    for (let i = 0; i < toolsString.length; i++) {
      const char = toolsString[i];

      if (char === "(") {
        depth++;
        current += char;
      } else if (char === ")") {
        depth--;
        current += char;
      } else if (char === "," && depth === 0) {
        if (current.trim()) {
          tools.push(this.normalizePattern(current.trim()));
        }
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      tools.push(this.normalizePattern(current.trim()));
    }

    return tools;
  }

  private normalizePattern(pattern: string): string {
    const trimmed = pattern.trim();

    if (trimmed.includes("(")) {
      return normalizePermissionRule(trimmed);
    }

    const canonicalTool = canonicalToolName(trimmed);

    if (isShellToolName(canonicalTool)) {
      return "Bash(:*)";
    }

    if (isFileToolName(canonicalTool)) {
      return `${canonicalTool}(**)`;
    }

    return canonicalTool;
  }

  getAllowedTools(): string[] {
    return [
      ...(getRuntimeContext()?.executionSettings?.allowed_tools ??
        this.allowedTools),
    ];
  }

  getDisallowedTools(): string[] {
    return [
      ...(getRuntimeContext()?.executionSettings?.disallowed_tools ??
        this.disallowedTools),
    ];
  }

  isMemoryGuardDisabled(): boolean {
    return (
      getRuntimeContext()?.executionSettings?.disable_memory_guard ??
      this.memoryGuardDisabled
    );
  }

  clear(): void {
    this.allowedTools = [];
    this.disallowedTools = [];
    this.memoryGuardDisabled = false;
  }
}
