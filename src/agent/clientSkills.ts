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
  skillsDirectory: string;
  skillSources: SkillSource[];
} {
  const skillsDirectory =
    options.skillsDirectory ??
    getSkillsDirectory() ??
    join(process.cwd(), SKILLS_DIR);
  const skillSources = options.skillSources ?? getSkillSources();
  return { skillsDirectory, skillSources };
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
  const { skillsDirectory, skillSources } =
    resolveSkillDiscoveryContext(options);
  const discoverSkillsFn = options.discoverSkillsFn ?? discoverSkills;

  try {
    const discovery = await discoverSkillsFn(skillsDirectory, options.agentId, {
      sources: skillSources,
    });
    const sortedSkills = [...discovery.skills].sort(compareSkills);

    return {
      clientSkills: sortedSkills.map(toClientSkill),
      skillPathById: Object.fromEntries(
        sortedSkills
          .filter(
            (skill) => typeof skill.path === "string" && skill.path.length > 0,
          )
          .map((skill) => [skill.id, skill.path]),
      ),
      errors: discovery.errors,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Unknown error: ${String(error)}`;
    options.logger?.(`Failed to build client_skills payload: ${message}`);
    return {
      clientSkills: [],
      skillPathById: {},
      errors: [
        {
          path: skillsDirectory,
          message,
        },
      ],
    };
  }
}
