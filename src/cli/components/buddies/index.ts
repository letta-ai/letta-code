import { cat } from "./cat";
import { dog } from "./dog";
import { robot } from "./robot";
import type { BuddyDefinition, BuddyState } from "./types";

export type { BuddyDefinition, BuddyState } from "./types";

/**
 * Registry of all available buddies
 */
export const BUDDIES: Record<string, BuddyDefinition> = {
  cat,
  dog,
  robot,
};

/**
 * Get list of available buddy names
 */
export function getBuddyNames(): string[] {
  return Object.keys(BUDDIES);
}

/**
 * Check if a buddy name is valid
 */
export function isValidBuddy(name: string): boolean {
  return name in BUDDIES;
}

/**
 * Get a buddy definition by name
 */
export function getBuddy(name: string): BuddyDefinition | undefined {
  return BUDDIES[name];
}
