/**
 * Tags that identify Letta Code agents and their capabilities.
 *
 * This module must stay free of Node/backend imports: it is bundled into the
 * browser-safe `@letta-ai/letta-code/agent-presets` package export.
 */

/** Marks an agent as created/managed by Letta Code. */
export const LETTA_CODE_ORIGIN_TAG = "origin:letta-code";

/** Marks an agent as created by a first-run onboarding flow. */
export const ONBOARDING_ORIGIN_TAG = "origin:onboarding";

/** Marks an agent as a Letta Code subagent (excluded from prompt management). */
export const LETTA_CODE_SUBAGENT_TAG = "role:subagent";

/** Marks an agent as using git-backed memory (MemFS). */
export const GIT_MEMORY_ENABLED_TAG = "git-memory-enabled";

export interface BuildCreatedAgentTagsOptions {
  tags?: string[] | null;
  isSubagent?: boolean;
  enableMemfs?: boolean;
}

export function buildCreatedAgentTags(
  options: BuildCreatedAgentTagsOptions = {},
): string[] {
  const tags = [LETTA_CODE_ORIGIN_TAG];
  if (options.isSubagent) {
    tags.push(LETTA_CODE_SUBAGENT_TAG);
  }
  if (options.enableMemfs) {
    tags.push(GIT_MEMORY_ENABLED_TAG);
  }
  if (options.tags && Array.isArray(options.tags)) {
    tags.push(...options.tags);
  }
  return Array.from(new Set(tags));
}
