/**
 * Buddy state types for ASCII animation
 */
export type BuddyState =
  | "idle"
  | "thinking"
  | "success"
  | "error"
  | "waiting";

/**
 * Animation frames for a single state
 */
export interface StateAnimation {
  frames: string[];
  interval: number; // ms between frames
}

/**
 * Complete buddy definition with all states
 */
export interface BuddyDefinition {
  name: string;
  description: string;
  width: number; // character width for consistent sizing
  height: number; // line height
  states: Record<BuddyState, StateAnimation>;
}
