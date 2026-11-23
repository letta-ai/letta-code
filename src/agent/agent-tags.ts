export const LETTA_CODE_ORIGIN_TAG = "origin:letta-code";

export const ONBOARDING_ORIGIN_TAG = "origin:onboarding";

export const LETTA_CODE_SUBAGENT_TAG = "role:subagent";

export const GIT_MEMORY_ENABLED_TAG = "git-memory-enabled";

export const MEMFS_DISABLED_TAG = "memfs:disabled";

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

export function isStatelessSubagentTags(
  tags: readonly string[] | null | undefined,
): boolean {
  return Boolean(
    tags?.includes(LETTA_CODE_SUBAGENT_TAG) &&
      !tags.includes(GIT_MEMORY_ENABLED_TAG),
  );
}

export function isMemfsOptOutCreateTags(tags: unknown): boolean {
  return Array.isArray(tags) && tags.includes(MEMFS_DISABLED_TAG);
}
