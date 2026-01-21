// src/hooks/matcher.ts
// Pattern matching for hook matchers

import type { HookCommand, HookMatcher } from "./types";

/**
 * Check if a value matches a hook matcher pattern.
 *
 * Pattern types:
 * - Empty string or "*": Matches everything
 * - Simple string: Exact match (case-sensitive)
 * - Regex pattern: Uses RegExp for matching (e.g., "Edit|Write", "Bash.*")
 *
 * @param value - The value to match (tool name, notification type, etc.)
 * @param pattern - The pattern to match against
 * @returns true if the value matches the pattern
 */
export function matchesPattern(value: string, pattern: string): boolean {
  // Empty string or "*" matches everything
  if (!pattern || pattern === "*") {
    return true;
  }

  // Try exact match first (most common case)
  if (pattern === value) {
    return true;
  }

  // Try regex match
  try {
    const regex = new RegExp(`^(?:${pattern})$`);
    return regex.test(value);
  } catch {
    // If regex is invalid, fall back to exact match (already checked above)
    return false;
  }
}

/**
 * Get all hook commands that match a given value.
 *
 * @param value - The value to match (tool name, notification type, etc.)
 * @param matchers - Array of hook matchers to check
 * @returns Array of matching hook commands (deduplicated)
 */
export function getMatchingHooks(
  value: string,
  matchers: HookMatcher[] | undefined,
): HookCommand[] {
  if (!matchers || matchers.length === 0) {
    return [];
  }

  const matchingHooks: HookCommand[] = [];
  const seenCommands = new Set<string>();

  for (const matcher of matchers) {
    if (matchesPattern(value, matcher.matcher ?? "")) {
      for (const hook of matcher.hooks) {
        // Deduplicate by command string
        const key = `${hook.type}:${hook.command}`;
        if (!seenCommands.has(key)) {
          seenCommands.add(key);
          matchingHooks.push(hook);
        }
      }
    }
  }

  return matchingHooks;
}

/**
 * Check if any hooks exist for a given event and optional matcher value.
 *
 * @param matchers - Array of hook matchers for the event
 * @param value - Optional value to match against (tool name, etc.)
 * @returns true if there are any matching hooks
 */
export function hasMatchingHooks(
  matchers: HookMatcher[] | undefined,
  value?: string,
): boolean {
  if (!matchers || matchers.length === 0) {
    return false;
  }

  // If no value provided, check if any matchers exist
  if (value === undefined) {
    return matchers.some((m) => m.hooks.length > 0);
  }

  // Check if any hooks match the value
  return getMatchingHooks(value, matchers).length > 0;
}
