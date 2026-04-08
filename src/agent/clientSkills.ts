import { join } from "node:path";
import type { MessageCreateParams as ConversationMessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import { getSkillSources, getSkillsDirectory } from "./context";
import {
  compareSkills,
  discoverSkills,
  SKILLS_DIR,
  type Skill,
  type SkillDiscoveryError,
  type SkillDiscoveryResult,
  type SkillSource,
} from "./skills";

function getMemorySkillsDirs(agentId?: string): string[] {
  const dirs = new Set<string>();

  const memoryDir = process.env.MEMORY_DIR || process.env.LETTA_MEMORY_DIR;
  if (memoryDir && memoryDir.trim().length > 0) {
    dirs.add(join(memoryDir.trim(), "skills"));
  }

  if (agentId) {
    dirs.add(
      join(
        process.env.HOME || process.env.USERPROFILE || "~",
        ".letta/agents",
        agentId,
        "memory",
        "skills",
      ),
    );
  }

  return Array.from(dirs);
}

async function discoverMemorySkills(
  agentId?: string,
): Promise<SkillDiscoveryResult> {
  const skillsById = new Map<string, Skill>();
  const errors: SkillDiscoveryError[] = [];

  for (const dir of getMemorySkillsDirs(agentId)) {
    try {
      // Reuse the canonical skill parser by scanning this path as a project scope.
      // We remap source to "agent" because memory skill precedence should be:
      // project > agent > memory > global > bundled.
      const discovery = await discoverSkills(dir, undefined, {
        sources: ["project"],
        skipBundled: true,
      });
      errors.push(...discovery.errors);
      for (const skill of discovery.skills) {
        if (!skillsById.has(skill.id)) {
          skillsById.set(skill.id, { ...skill, source: "agent" });
        }
      }
    } catch (error) {
      errors.push({
        path: dir,
        message:
          error instanceof Error
            ? error.message
            : `Unknown error: ${String(error)}`,
      });
    }
  }

  return {
    skills: [...skillsById.values()].sort(compareSkills),
    errors,
  };
}

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

  // MemFS skills are discovered by the Skill tool, so include them in
  // client_skills as well. This keeps the model's available-skills list in
  // sync with actual Skill(...) resolution in desktop/listen mode.
  if (skillSources.length > 0) {
    const memoryDiscovery = await discoverMemorySkills(options.agentId);
    errors.push(...memoryDiscovery.errors);
    for (const skill of memoryDiscovery.skills) {
      const existing = skillsById.get(skill.id);

      // Preserve higher-priority skills: project and agent-scoped.
      // MemFS should override only global/bundled or fill missing ids.
      if (existing?.source === "project" || existing?.source === "agent") {
        continue;
      }

      skillsById.set(skill.id, skill);
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
