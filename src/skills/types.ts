/**
 * Represents a skill that can be used by the agent
 */
export interface Skill {
  /** Unique identifier for the skill */
  id: string;
  /** Human-readable name of the skill */
  name: string;
  /** Description of what the skill does */
  description: string;
  /** Optional category for organizing skills */
  category?: string;
  /** Optional tags for filtering/searching skills */
  tags?: string[];
  /** Path to the skill file */
  path: string;
}

/**
 * Represents the result of skill discovery
 */
export interface SkillDiscoveryResult {
  /** List of discovered skills */
  skills: Skill[];
  /** Any errors encountered during discovery */
  errors: SkillDiscoveryError[];
}

/**
 * Represents an error that occurred during skill discovery
 */
export interface SkillDiscoveryError {
  /** Path where the error occurred */
  path: string;
  /** Error message */
  message: string;
}
