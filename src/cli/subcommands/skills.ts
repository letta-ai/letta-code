import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { deleteSkill, installSkill, listSkills } from "@/agent/skill-installer";
import {
  type InstallLocalManagedModPackageResult,
  installGitManagedModPackage,
  installLocalManagedModPackage,
  installNpmManagedModPackage,
  isLocalLettaModPackageDirectory,
  parseGitManagedModPackageInstallSpecifier,
} from "@/mods/package-installer";
import { resolveDefaultGlobalModsDirectory } from "@/mods/paths";

interface RunInstallOptions {
  globalModsDirectory?: string;
}

let activeAgentPromptStatus: { stop: () => void } | null = null;
function printUsage(): void {
  console.log(
    `
Usage:
  letta install <thing> [--agent <id> | -n <agent name>] [--force]
  letta skills list [--agent <id> | -n <agent name>]
  letta skills delete <skill_name> --agent <id>

Sources:
  npm:<package>         npm mod package, e.g. npm:@letta-ai/mod-plan-mode
  git:github.com/o/r    GitHub mod package
  https://github.com/o/r GitHub mod package
  ./path/to/package     Local mod package with package.json#letta
  official/<path>         Hermes official optional skill, e.g. official/finance/stocks
  clawhub/<slug>          ClawHub registry skill, e.g. clawhub/nano-banana-pro
  clawhub:<slug>          ClawHub registry skill, optionally <slug>@<version>
  https://github.com/...  GitHub repository, tree URL, or SKILL.md blob URL
  https://.../SKILL.md    Direct external skill file URL
  owner/repo/path         GitHub repo/path shorthand

Options:
  --agent <id>            Install into this agent's memfs repository
  --agent-id <id>         Alias for --agent
  -n, --name <name>       Install into the agent with this exact name
  --force                 Replace an existing skill with the same name
`.trim(),
  );
}

const SKILLS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string" },
  "agent-id": { type: "string" },
  name: { type: "string", short: "n" },
  force: { type: "boolean" },
} as const;

function parseSkillsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: SKILLS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function isAgentId(value: string): boolean {
  return value.startsWith("agent-") || value.startsWith("agent_");
}

function getExplicitAgentId(
  values: ReturnType<typeof parseSkillsArgs>["values"],
): string | null {
  const explicitAgent = values.agent || values["agent-id"];
  return typeof explicitAgent === "string" && explicitAgent.trim()
    ? explicitAgent.trim()
    : null;
}

function paginatedItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  const items = (page as { items?: unknown }).items;
  return Array.isArray(items) ? (items as T[]) : [];
}

async function findAgentsByName(name: string): Promise<AgentState[]> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();
  const page = await backend.listAgents({
    query_text: name,
    limit: 100,
  } as never);
  const normalizedName = name.toLowerCase();
  return paginatedItems<AgentState>(page).filter(
    (agent) => agent.name?.toLowerCase() === normalizedName,
  );
}

async function resolveAgentByName(name: string): Promise<string> {
  const matches = await findAgentsByName(name);
  if (matches.length === 0) {
    throw new Error(`No agent found with name "${name}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple agents found with name "${name}". Pass --agent with an agent id instead.`,
    );
  }
  const id = matches[0]?.id;
  if (!id) throw new Error(`Agent "${name}" did not include an id.`);
  return id;
}

async function promptForAgent(statusMessage: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Missing agent id. Pass --agent <id> or -n <agent name>.");
  }

  const { Box, render } = await import("ink");
  const Spinner = (await import("ink-spinner")).default;
  const React = await import("react");
  const { AgentSelector } = await import("@/cli/components/AgentSelector");
  const { Text } = await import("@/cli/components/Text");

  return new Promise<string>((resolveAgent, rejectAgent) => {
    let settled = false;
    const statusView = React.createElement(
      Box,
      { paddingX: 1, paddingY: 1 },
      React.createElement(
        Text,
        null,
        React.createElement(Spinner, { type: "dots" }),
        ` ${statusMessage}`,
      ),
    );
    const instance = render(
      React.createElement(AgentSelector, {
        currentAgentId:
          process.env.LETTA_AGENT_ID || process.env.AGENT_ID || "",
        command: "letta skills",
        title: "Select an agent",
        showNewTab: false,
        allowDelete: false,
        allowPinActions: false,
        onSelect: (agentId: string) => {
          if (settled) return;
          settled = true;
          instance.rerender(statusView);
          activeAgentPromptStatus = {
            stop: () => {
              instance.unmount();
              instance.clear?.();
              if (activeAgentPromptStatus?.stop) {
                activeAgentPromptStatus = null;
              }
            },
          };
          setTimeout(() => resolveAgent(agentId), 0);
        },
        onCancel: () => {
          if (settled) return;
          settled = true;
          instance.unmount();
          instance.clear?.();
          rejectAgent(new Error("Agent selection cancelled."));
        },
      }),
    );
  });
}

async function resolveAgentId(
  values: ReturnType<typeof parseSkillsArgs>["values"],
  promptStatusMessage = "Working...",
): Promise<string> {
  const explicitAgent = getExplicitAgentId(values);
  if (explicitAgent) return explicitAgent;

  if (typeof values.name === "string" && values.name.trim()) {
    const nameOrId = values.name.trim();
    if (isAgentId(nameOrId)) return nameOrId;
    return resolveAgentByName(nameOrId);
  }

  const envAgent = process.env.LETTA_AGENT_ID || process.env.AGENT_ID;
  if (envAgent?.trim()) return envAgent.trim();

  return promptForAgent(promptStatusMessage);
}

async function initializeAndResolveAgent(
  values: ReturnType<typeof parseSkillsArgs>["values"],
  promptStatusMessage?: string,
): Promise<string> {
  const { settingsManager } = await import("@/settings-manager");
  await settingsManager.initialize();
  return resolveAgentId(values, promptStatusMessage);
}

function stopAgentPromptStatus(): void {
  activeAgentPromptStatus?.stop();
  activeAgentPromptStatus = null;
}

function hasInstallAgentScope(
  values: ReturnType<typeof parseSkillsArgs>["values"],
): boolean {
  return Boolean(values.agent || values["agent-id"] || values.name);
}

function printManagedModPackageInstallResult(
  result: InstallLocalManagedModPackageResult,
  options: { includeDetails?: boolean } = {},
): void {
  console.log(
    "Warning: mods are trusted local code and can execute on startup.",
  );
  if (options.includeDetails) {
    console.log(`Source: ${result.source}`);
    if (result.repository) {
      console.log(`Repository: ${result.repository}`);
    }
    if (result.capabilities.length > 0) {
      console.log(`Capabilities: ${result.capabilities.join(", ")}`);
    }
  }
  console.log(`Installed ${result.source}@${result.version}`);
  console.log("Run /reload in active sessions for changes to take effect.");
}

async function runInstall(
  argv: string[],
  options: RunInstallOptions = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseSkillsArgs>;
  try {
    parsed = parseSkillsArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  const [specifier] = parsed.positionals;
  if (parsed.values.help || !specifier || specifier === "help") {
    printUsage();
    return 0;
  }

  if (parsed.positionals.length > 1) {
    console.error(`Unexpected argument: ${parsed.positionals[1]}`);
    printUsage();
    return 1;
  }

  if (specifier.startsWith("npm:")) {
    if (hasInstallAgentScope(parsed.values)) {
      console.error("Agent-scoped mod package install is not supported yet.");
      return 1;
    }
    if (parsed.values.force) {
      console.error("--force is only supported for skill installs.");
      return 1;
    }
    try {
      const result = await installNpmManagedModPackage({
        modsRoot:
          options.globalModsDirectory ?? resolveDefaultGlobalModsDirectory(),
        specifier,
      });
      printManagedModPackageInstallResult(result, { includeDetails: true });
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  let gitPackageSpecifier: ReturnType<
    typeof parseGitManagedModPackageInstallSpecifier
  >;
  try {
    gitPackageSpecifier = parseGitManagedModPackageInstallSpecifier(specifier);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (gitPackageSpecifier) {
    if (hasInstallAgentScope(parsed.values)) {
      console.error("Agent-scoped mod package install is not supported yet.");
      return 1;
    }
    if (parsed.values.force) {
      console.error("--force is only supported for skill installs.");
      return 1;
    }
    try {
      const result = await installGitManagedModPackage({
        modsRoot:
          options.globalModsDirectory ?? resolveDefaultGlobalModsDirectory(),
        specifier,
      });
      printManagedModPackageInstallResult(result, { includeDetails: true });
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  const maybeLocalPath = resolve(specifier);
  if (isLocalLettaModPackageDirectory(maybeLocalPath)) {
    if (hasInstallAgentScope(parsed.values)) {
      console.error("Agent-scoped mod package install is not supported yet.");
      return 1;
    }
    try {
      const result = installLocalManagedModPackage({
        modsRoot:
          options.globalModsDirectory ?? resolveDefaultGlobalModsDirectory(),
        packageDirectory: maybeLocalPath,
      });
      printManagedModPackageInstallResult(result);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  try {
    const agentId = await initializeAndResolveAgent(
      parsed.values,
      `Installing ${specifier}...`,
    );
    const result = await installSkill(
      specifier,
      agentId,
      Boolean(parsed.values.force),
    );
    stopAgentPromptStatus();
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    stopAgentPromptStatus();
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runInstallSubcommand(
  argv: string[],
  options: RunInstallOptions = {},
): Promise<number> {
  return runInstall(argv, options);
}

async function runList(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseSkillsArgs>;
  try {
    parsed = parseSkillsArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  if (parsed.values.help) {
    printUsage();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(`Unexpected argument: ${parsed.positionals[0]}`);
    printUsage();
    return 1;
  }

  try {
    const agentId = await initializeAndResolveAgent(
      parsed.values,
      "Loading skills...",
    );
    const result = await listSkills(agentId);
    stopAgentPromptStatus();
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    stopAgentPromptStatus();
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runDelete(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseSkillsArgs>;
  try {
    parsed = parseSkillsArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  const [skillName] = parsed.positionals;
  if (parsed.values.help || !skillName || skillName === "help") {
    printUsage();
    return 0;
  }
  if (parsed.positionals.length > 1) {
    console.error(`Unexpected argument: ${parsed.positionals[1]}`);
    printUsage();
    return 1;
  }

  const agentId = getExplicitAgentId(parsed.values);
  if (!agentId) {
    console.error(
      "Deleting a skill requires an explicit agent id. Re-run with --agent <id> or --agent-id <id>.",
    );
    return 1;
  }

  if (skillName.includes("/")) {
    console.error(
      `Invalid installed skill name "${skillName}". Delete expects the installed directory name, e.g. "meme-generation", not a source specifier like "official/creative/meme-generation".`,
    );
    return 1;
  }

  try {
    const { settingsManager } = await import("@/settings-manager");
    await settingsManager.initialize();
    const result = await deleteSkill(skillName, agentId);
    stopAgentPromptStatus();
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    stopAgentPromptStatus();
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runSkillsSubcommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  switch (action) {
    case "install":
      return runInstall(rest);
    case "list":
      return runList(rest);
    case "delete":
    case "remove":
    case "rm":
      return runDelete(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return 0;
    default:
      console.error(`Unknown action: ${action}`);
      printUsage();
      return 1;
  }
}
