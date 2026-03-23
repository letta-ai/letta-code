import { join } from "node:path";
import type { MessageCreateParams as ConversationMessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import { getSkillSources, getSkillsDirectory } from "./context";
import {
  compareSkills,
  discoverSkills,
  SKILLS_DIR,
  type Skill,
  type SkillDiscoveryError,
  type SkillSource,
} from "./skills";

export type ClientSkill = NonNullable<
  ConversationMessageCreateParams["client_skills"]
>[number];

export interface BuildClientSkillsPayloadOptions {
  agentId?: string;
  skillsDirectory?: string | null;
  skillSources?: SkillSource[];
  discoverSkillsFn?: typeof discoverSkills;
  logger?: (message: string) => void;
}

export interface BuildClientSkillsPayloadResult {
  clientSkills: NonNullable<ConversationMessageCreateParams["client_skills"]>;
  skillPathById: Record<string, string>;
  errors: SkillDiscoveryError[];
}

function toClientSkill(skill: Skill): ClientSkill {
  return {
    name: skill.id,
    description: skill.description,
    location: skill.path,
  };
}

function resolveSkillDiscoveryContext(
  options: BuildClientSkillsPayloadOptions,
): {
  legacySkillsDirectory: string;
  skillSources: SkillSource[];
} {
  const legacySkillsDirectory =
    options.skillsDirectory ??
    getSkillsDirectory() ??
    join(process.cwd(), SKILLS_DIR);
  const skillSources = options.skillSources ?? getSkillSources();
  return { legacySkillsDirectory, skillSources };
}

function getPrimaryProjectSkillsDirectory(): string {
  return join(process.cwd(), ".agents", "skills");
}

/**
 * Build `client_skills` payload for conversations.messages.create.
 *
 * This discovers client-side skills using the same source selection rules as the
 * Skill tool and headless startup flow, then converts them into the server-facing
 * schema expected by the API. Ordering is deterministic by skill id.
 */
export async function buildClientSkillsPayload(
  options: BuildClientSkillsPayloadOptions = {},
): Promise<BuildClientSkillsPayloadResult> {
  const { legacySkillsDirectory, skillSources } =
    resolveSkillDiscoveryContext(options);
  const discoverSkillsFn = options.discoverSkillsFn ?? discoverSkills;
  const skillsById = new Map<string, Skill>();
  const errors: SkillDiscoveryError[] = [];

  const primaryProjectSkillsDirectory = getPrimaryProjectSkillsDirectory();
  const nonProjectSources = skillSources.filter(
    (source): source is SkillSource => source !== "project",
  );

  const discoveryRuns: Array<{ path: string; sources: SkillSource[] }> = [];

  // For bundled/global/agent sources, use the primary project root.
  if (nonProjectSources.length > 0) {
    discoveryRuns.push({
      path: primaryProjectSkillsDirectory,
      sources: nonProjectSources,
    });
  }

  const includeProjectSource = skillSources.includes("project");

  // Legacy project location (.skills): discovered first so primary path can override.
  if (
    includeProjectSource &&
    legacySkillsDirectory !== primaryProjectSkillsDirectory
  ) {
    discoveryRuns.push({
      path: legacySkillsDirectory,
      sources: ["project"],
    });
  }

  // Primary location for project-scoped client skills.
  if (includeProjectSource) {
    discoveryRuns.push({
      path: primaryProjectSkillsDirectory,
      sources: ["project"],
    });
  }

  for (const run of discoveryRuns) {
    try {
      const discovery = await discoverSkillsFn(run.path, options.agentId, {
        sources: run.sources,
      });
      errors.push(...discovery.errors);
      for (const skill of discovery.skills) {
        skillsById.set(skill.id, skill);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Unknown error: ${String(error)}`;
      errors.push({ path: run.path, message });
    }
  }

  const sortedSkills = [...skillsById.values()].sort(compareSkills);

  if (errors.length > 0) {
    const summarizedErrors = errors.map(
      (error) => `${error.path}: ${error.message}`,
    );
    options.logger?.(
      `Failed to build some client_skills entries: ${summarizedErrors.join("; ")}`,
    );
  }

  return {
    clientSkills: sortedSkills.map(toClientSkill),
    skillPathById: Object.fromEntries(
      sortedSkills
        .filter(
          (skill) => typeof skill.path === "string" && skill.path.length > 0,
        )
        .map((skill) => [skill.id, skill.path]),
    ),
    errors,
  };
}
