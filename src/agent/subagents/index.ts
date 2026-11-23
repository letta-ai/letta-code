import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalMemoryFormat } from "@/agent/memory-format";
import { getBackend } from "@/backend";
import { findRemovedToolNames } from "@/tools/removed-tools";
import { getErrorMessage } from "@/utils/error";
import {
  getStringField,
  parseCommaSeparatedList,
  parseFrontmatter,
} from "@/utils/frontmatter";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import forkAgentMd from "./builtin/fork.md";
import generalPurposeAgentMd from "./builtin/general-purpose.md";
import initAgentMd from "./builtin/init.md";
import initV2AgentMd from "./builtin/init-v2.md";
import memoryAgentMd from "./builtin/memory.md";
import recallAgentMd from "./builtin/recall.md";
import reflectionAgentMd from "./builtin/reflection.md";
import reflectionV2AgentMd from "./builtin/reflection-v2.md";
import { MODEL_HIDDEN_SUBAGENT_NAMES } from "./subagent-names";

const STANDARD_BUILTIN_SOURCES = [
  forkAgentMd,
  generalPurposeAgentMd,
  initAgentMd,
  memoryAgentMd,
  recallAgentMd,
  reflectionAgentMd,
];

const LOCAL_MEMFS_BUILTIN_SOURCES = [
  forkAgentMd,
  generalPurposeAgentMd,
  initAgentMd,
  memoryAgentMd,
  recallAgentMd,
  reflectionAgentMd,
];

const MEMFS_V2_BUILTIN_SOURCES = [initV2AgentMd, reflectionV2AgentMd];

export type SubagentLaunchProfile = "default" | "memory-subagent";
export type SubagentRecommendedModelSource = "builtin" | "user";

export interface SubagentMemoryScope {
  primaryRoot: string | null;
  writableRoots: string[];
  readonlyRoots?: string[];
}

export interface SubagentResult {
  agentId: string;
  conversationId?: string;
  runtimeSessionId?: string;
  model?: string;
  report: string;
  success: boolean;
  error?: string;
  totalTokens?: number;
  stepCount?: number;
  durationMs?: number;
}

export interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[] | "all";
  recommendedModel: string;
  recommendedModelSource?: SubagentRecommendedModelSource;
  skills: string[];
  fork: boolean;
  launchProfile: SubagentLaunchProfile;
}

export interface SubagentDiscoveryResult {
  subagents: SubagentConfig[];
  errors: Array<{ path: string; message: string }>;
}

export const AGENTS_DIR = ".letta/agents";

export function getGlobalAgentsDir(): string {
  return join(resolveGlobalConfigDir(), "agents");
}

export const GLOBAL_AGENTS_DIR = getGlobalAgentsDir();
const RESERVED_EXTERNAL_SUBAGENT_NAMES = new Set([
  "letta",
  "claude-code",
  "codex",
  "opencode",
  "cursor",
]);

const cache = {
  builtins: {
    standard: null as Record<string, SubagentConfig> | null,
    localMemfs: null as Record<string, SubagentConfig> | null,
  },
  configs: null as Record<string, SubagentConfig> | null,
  workingDir: null as string | null,
  localMemfs: null as boolean | null,
};

function isValidName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

function parseTools(toolsStr: string | undefined): string[] | "all" {
  if (
    !toolsStr ||
    toolsStr.trim() === "" ||
    toolsStr.trim().toLowerCase() === "all"
  ) {
    return "all";
  }
  const tools = parseCommaSeparatedList(toolsStr);
  return tools.length > 0 ? tools : "all";
}

function parseSkills(skillsStr: string | undefined): string[] {
  return parseCommaSeparatedList(skillsStr);
}

function parseLaunchProfile(
  launchProfile: string | undefined,
): SubagentLaunchProfile {
  return launchProfile === "memory-subagent" ? "memory-subagent" : "default";
}

function validateFrontmatter(
  frontmatter: Record<string, string | string[]>,
  options: { requireDescription?: boolean } = {},
): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  const name = frontmatter.name;
  if (!name || typeof name !== "string") {
    errors.push("Missing required field: name");
  } else if (!isValidName(name)) {
    errors.push(
      `Invalid name "${name}": must start with lowercase letter and contain only lowercase letters, numbers, and hyphens`,
    );
  }

  const description = frontmatter.description;
  if (options.requireDescription !== false) {
    if (!description || typeof description !== "string") {
      errors.push("Missing required field: description");
    }
  }

  return { valid: errors.length === 0, errors };
}

interface ParseSubagentContentOptions {
  inheritedConfigs?: Record<string, SubagentConfig>;
  modelSource?: SubagentRecommendedModelSource;
}

function hasFrontmatterField(
  frontmatter: Record<string, string | string[]>,
  field: string,
): boolean {
  return Object.hasOwn(frontmatter, field);
}

function cloneAllowedTools(allowedTools: string[] | "all"): string[] | "all" {
  return allowedTools === "all" ? "all" : [...allowedTools];
}

function applySubagentOverlay(
  inherited: SubagentConfig,
  frontmatter: Record<string, string | string[]>,
  modelSource: SubagentRecommendedModelSource | undefined,
): SubagentConfig {
  const hasModel = hasFrontmatterField(frontmatter, "model");

  return {
    ...inherited,
    name: frontmatter.name as string,
    description: hasFrontmatterField(frontmatter, "description")
      ? getStringField(frontmatter, "description") || inherited.description
      : inherited.description,
    systemPrompt: inherited.systemPrompt,
    allowedTools: hasFrontmatterField(frontmatter, "tools")
      ? parseTools(getStringField(frontmatter, "tools"))
      : cloneAllowedTools(inherited.allowedTools),
    recommendedModel: hasModel
      ? getStringField(frontmatter, "model") || "inherit"
      : inherited.recommendedModel,
    recommendedModelSource: hasModel
      ? modelSource
      : inherited.recommendedModelSource,
    skills: hasFrontmatterField(frontmatter, "skills")
      ? parseSkills(getStringField(frontmatter, "skills"))
      : [...inherited.skills],
    fork: hasFrontmatterField(frontmatter, "fork")
      ? getStringField(frontmatter, "fork")?.toLowerCase() === "true"
      : inherited.fork,
    launchProfile: hasFrontmatterField(frontmatter, "launchProfile")
      ? parseLaunchProfile(getStringField(frontmatter, "launchProfile"))
      : inherited.launchProfile,
  };
}

function parseSubagentContent(
  content: string,
  options: ParseSubagentContentOptions = {},
): SubagentConfig {
  const { frontmatter, body } = parseFrontmatter(content);

  const nameValidation = validateFrontmatter(frontmatter, {
    requireDescription: false,
  });
  if (!nameValidation.valid) {
    throw new Error(nameValidation.errors.join("; "));
  }

  const name = frontmatter.name as string;
  const isBodyless = body.trim().length === 0;

  if (isBodyless) {
    const inherited = options.inheritedConfigs?.[name];
    if (!inherited) {
      throw new Error(
        `Bodyless subagent overlay "${name}" requires an existing lower-precedence config`,
      );
    }

    return applySubagentOverlay(inherited, frontmatter, options.modelSource);
  }

  const validation = validateFrontmatter(frontmatter);
  if (!validation.valid) {
    throw new Error(validation.errors.join("; "));
  }

  const description = frontmatter.description as string;
  const hasModel = hasFrontmatterField(frontmatter, "model");

  return {
    name,
    description,
    systemPrompt: body,
    allowedTools: parseTools(getStringField(frontmatter, "tools")),
    recommendedModel: getStringField(frontmatter, "model") || "inherit",
    recommendedModelSource: hasModel ? options.modelSource : undefined,
    skills: parseSkills(getStringField(frontmatter, "skills")),
    fork: getStringField(frontmatter, "fork")?.toLowerCase() === "true",
    launchProfile: parseLaunchProfile(
      getStringField(frontmatter, "launchProfile"),
    ),
  };
}

async function parseSubagentFile(
  filePath: string,
  inheritedConfigs: Record<string, SubagentConfig>,
): Promise<SubagentConfig | null> {
  const content = await readFile(filePath, "utf-8");
  return parseSubagentContent(content, {
    inheritedConfigs,
    modelSource: "user",
  });
}

function usesLocalMemfsBuiltinPrompts(): boolean {
  return getBackend().capabilities.localMemfs;
}

function getBuiltinSubagents(
  localMemfs = usesLocalMemfsBuiltinPrompts(),
): Record<string, SubagentConfig> {
  const cacheKey = localMemfs ? "localMemfs" : "standard";
  if (cache.builtins[cacheKey]) {
    return cache.builtins[cacheKey];
  }

  const builtins: Record<string, SubagentConfig> = {};
  const sources = localMemfs
    ? LOCAL_MEMFS_BUILTIN_SOURCES
    : STANDARD_BUILTIN_SOURCES;

  for (const source of sources) {
    try {
      const config = parseSubagentContent(source, {
        modelSource: "builtin",
      });
      builtins[config.name] = config;
    } catch (error) {
      console.warn(
        `[subagent] Failed to parse built-in subagent: ${getErrorMessage(error)}`,
      );
    }
  }

  cache.builtins[cacheKey] = builtins;
  return builtins;
}

let localMemfsV2Builtins: Record<string, SubagentConfig> | null = null;

function getLocalMemfsV2Builtins(): Record<string, SubagentConfig> {
  if (localMemfsV2Builtins) return localMemfsV2Builtins;
  const configs: Record<string, SubagentConfig> = {};
  for (const source of MEMFS_V2_BUILTIN_SOURCES) {
    const config = parseSubagentContent(source, { modelSource: "builtin" });
    configs[config.name] = config;
  }
  localMemfsV2Builtins = configs;
  return configs;
}

export function resolveSubagentConfigForMemoryFormat(
  config: SubagentConfig,
  memoryFormat: LocalMemoryFormat,
  localMemfs: boolean,
): SubagentConfig {
  if (memoryFormat !== "memfs-v2") return config;
  const v1Builtin = getBuiltinSubagents(localMemfs)[config.name];
  const v2Builtin = getLocalMemfsV2Builtins()[config.name];
  if (
    !v1Builtin ||
    !v2Builtin ||
    config.systemPrompt !== v1Builtin.systemPrompt
  ) {
    return config;
  }
  return {
    ...config,
    systemPrompt: v2Builtin.systemPrompt,
    skills:
      config.skills.join(",") === v1Builtin.skills.join(",")
        ? [...v2Builtin.skills]
        : config.skills,
  };
}

export function getBuiltinSubagentNames(): Set<string> {
  return new Set(Object.keys(getBuiltinSubagents()));
}

async function discoverSubagentsFromDir(
  agentsDir: string,
  configsByName: Record<string, SubagentConfig>,
  subagents: SubagentConfig[],
  errors: Array<{ path: string; message: string }>,
): Promise<void> {
  if (!existsSync(agentsDir)) {
    return;
  }

  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const filePath = join(agentsDir, entry.name);

      try {
        const config = await parseSubagentFile(filePath, configsByName);
        if (
          config &&
          !RESERVED_EXTERNAL_SUBAGENT_NAMES.has(config.name) &&
          config.name !== "memory"
        ) {
          const existingIndex = subagents.findIndex(
            (s) => s.name === config.name,
          );
          if (existingIndex !== -1) {
            subagents.splice(existingIndex, 1);
          }

          configsByName[config.name] = config;
          subagents.push(config);
        }
      } catch (error) {
        errors.push({
          path: filePath,
          message: getErrorMessage(error),
        });
      }
    }
  } catch (error) {
    errors.push({
      path: agentsDir,
      message: `Failed to read agents directory: ${getErrorMessage(error)}`,
    });
  }
}

export async function discoverSubagents(
  workingDirectory: string = process.cwd(),
  inheritedConfigs: Record<string, SubagentConfig> = {
    ...getBuiltinSubagents(),
  },
): Promise<SubagentDiscoveryResult> {
  const errors: Array<{ path: string; message: string }> = [];
  const subagents: SubagentConfig[] = [];

  await discoverSubagentsFromDir(
    getGlobalAgentsDir(),
    inheritedConfigs,
    subagents,
    errors,
  );

  const projectAgentsDir = join(workingDirectory, AGENTS_DIR);
  await discoverSubagentsFromDir(
    projectAgentsDir,
    inheritedConfigs,
    subagents,
    errors,
  );

  return { subagents, errors };
}

export async function getAllSubagentConfigs(
  workingDirectory: string = process.cwd(),
): Promise<Record<string, SubagentConfig>> {
  const localMemfs = usesLocalMemfsBuiltinPrompts();
  if (
    cache.configs &&
    cache.workingDir === workingDirectory &&
    cache.localMemfs === localMemfs
  ) {
    return cache.configs;
  }

  const configs: Record<string, SubagentConfig> = {
    ...getBuiltinSubagents(localMemfs),
  };

  const { subagents, errors } = await discoverSubagents(
    workingDirectory,
    configs,
  );

  for (const error of errors) {
    console.warn(`[subagent] Warning: ${error.path}: ${error.message}`);
  }

  for (const subagent of subagents) {
    if (subagent.allowedTools === "all") continue;
    const removedTools = findRemovedToolNames(subagent.allowedTools);
    if (removedTools.length > 0) {
      console.warn(
        `[subagent] Warning: ${subagent.name}: these tools no longer exist and will be ignored: ${removedTools.join(", ")}`,
      );
    }
  }

  for (const subagent of subagents) {
    configs[subagent.name] = subagent;
  }

  cache.configs = configs;
  cache.workingDir = workingDirectory;
  cache.localMemfs = localMemfs;

  return configs;
}

export async function getModelFacingSubagentDescriptors(
  workingDirectory: string,
): Promise<
  Array<{ name: string; description: string; recommendedModel: string }>
> {
  const configs = await getAllSubagentConfigs(workingDirectory);
  return Object.entries(configs)
    .filter(([name]) => !MODEL_HIDDEN_SUBAGENT_NAMES.has(name))
    .map(([name, config]) => ({
      name,
      description: config.description,
      recommendedModel: config.recommendedModel,
    }));
}

export function clearSubagentConfigCache(): void {
  cache.configs = null;
  cache.workingDir = null;
  cache.localMemfs = null;
  localMemfsV2Builtins = null;
}
