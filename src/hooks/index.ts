// src/hooks/index.ts
// Hooks system - execute shell commands at various points in the agent lifecycle

export * from "./types";
export * from "./loader";
export * from "./matcher";
export * from "./input";
export { executeHooks, executeHookCommand, aggregateHookResults } from "./executor";

import type { HookCommand, HookEventResult, HookInput, HookEventName } from "./types";
import { getMatchingHooks } from "./matcher";
import { getEventHooks } from "./loader";
import { executeHooks } from "./executor";

/**
 * Run hooks for an event with the given input.
 * This is the main entry point for triggering hooks.
 *
 * @param eventName - Name of the hook event
 * @param input - Hook input data
 * @param matcherValue - Optional value to match against (tool name, notification type, etc.)
 * @returns Hook event result with aggregated outcomes
 */
export async function runHooks(
  eventName: HookEventName,
  input: HookInput,
  matcherValue?: string,
): Promise<HookEventResult> {
  // Get matchers for this event
  const matchers = getEventHooks(eventName);

  // If no matchers, return empty result
  if (!matchers || matchers.length === 0) {
    return {
      results: [],
      blocked: false,
      shouldContinue: true,
      systemMessages: [],
    };
  }

  // Get matching hook commands
  let commands: HookCommand[];
  if (matcherValue !== undefined) {
    commands = getMatchingHooks(matcherValue, matchers);
  } else {
    // For events without matchers (Stop, SubagentStop, etc.), get all hooks
    commands = matchers.flatMap((m) => m.hooks);
  }

  // If no matching commands, return empty result
  if (commands.length === 0) {
    return {
      results: [],
      blocked: false,
      shouldContinue: true,
      systemMessages: [],
    };
  }

  // Execute hooks and return aggregated result
  return executeHooks(commands, input);
}

/**
 * Check if any hooks are configured for an event.
 * Useful for short-circuiting when no hooks are configured.
 *
 * @param eventName - Name of the hook event
 * @param matcherValue - Optional value to check matching hooks
 * @returns true if hooks are configured
 */
export function hasHooksFor(
  eventName: HookEventName,
  matcherValue?: string,
): boolean {
  const matchers = getEventHooks(eventName);
  if (!matchers || matchers.length === 0) {
    return false;
  }

  if (matcherValue !== undefined) {
    return getMatchingHooks(matcherValue, matchers).length > 0;
  }

  return true;
}

/**
 * Run PermissionRequest hooks to check if a permission request should be auto-allowed/denied.
 * Call this before showing a permission dialog.
 *
 * @param sessionId - Session identifier (agent ID)
 * @param toolName - Name of the tool requesting permission
 * @param toolInput - Tool arguments
 * @param toolUseId - Tool call ID
 * @returns Hook result with permission decision, or null if no hooks configured
 */
export async function runPermissionRequestHooks(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
): Promise<{
  decision: "allow" | "deny" | null;
  updatedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
} | null> {
  if (!hasHooksFor("PermissionRequest", toolName)) {
    return null;
  }

  const { buildPermissionRequestInput } = await import("./input");
  const hookInput = buildPermissionRequestInput(sessionId, toolName, toolInput, toolUseId);
  const result = await runHooks("PermissionRequest", hookInput, toolName);

  // Check for permission request decision from hooks
  if (result.permissionRequestDecision) {
    return {
      decision: result.permissionRequestDecision.behavior,
      updatedInput: result.permissionRequestDecision.updatedInput,
      message: result.permissionRequestDecision.message,
      interrupt: result.permissionRequestDecision.interrupt,
    };
  }

  // Check for blocking (exit code 2 = deny)
  if (result.blocked) {
    return {
      decision: "deny",
      message: result.blockReason,
    };
  }

  return null;
}
