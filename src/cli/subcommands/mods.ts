import { join } from "node:path";
import { parseArgs } from "node:util";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { type LocalModSource, resolveLocalModSources } from "@/mods/mod-engine";

interface LooseModSection {
  files: string[];
  root: string;
}

export interface LooseModsList {
  agent?: LooseModSection;
  harness: LooseModSection;
}

export interface ListLooseModsOptions {
  agentId?: string | null;
  agentModsDirectory?: string | null;
  globalModsDirectory?: string;
}

const MODS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string" },
  "agent-id": { type: "string" },
} as const;

function printUsage(): void {
  console.log(
    `
Usage:
  letta mods list [--agent <id>]

Options:
  --agent <id>       Include loose mods from this agent's MemFS directory
  --agent-id <id>    Alias for --agent
  -h, --help         Show this help
`.trim(),
  );
}

function parseModsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: MODS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function getExplicitAgentId(
  values: ReturnType<typeof parseModsArgs>["values"],
): string | null {
  const explicitAgent = values.agent || values["agent-id"];
  return typeof explicitAgent === "string" && explicitAgent.trim()
    ? explicitAgent.trim()
    : null;
}

export function getAgentModsDirectory(agentId: string): string {
  return join(getScopedMemoryFilesystemRoot(agentId), "mods");
}

function toSection(source: LocalModSource): LooseModSection {
  return {
    files: [...source.files],
    root: source.root,
  };
}

export function listLooseMods(
  options: ListLooseModsOptions = {},
): LooseModsList {
  const agentModsDirectory =
    options.agentModsDirectory ??
    (options.agentId ? getAgentModsDirectory(options.agentId) : null);
  const sources = resolveLocalModSources({
    ...(agentModsDirectory ? { agentModsDirectory } : {}),
    ...(options.globalModsDirectory
      ? { globalModsDirectory: options.globalModsDirectory }
      : {}),
  });
  const harness = sources.find((source) => source.scope === "global");
  const agent = sources.find((source) => source.scope === "agent");

  return {
    ...(agent ? { agent: toSection(agent) } : {}),
    harness: harness ? toSection(harness) : { files: [], root: "" },
  };
}

function formatLooseModSection(
  title: string,
  section: LooseModSection,
): string {
  const lines = [title];
  if (section.files.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }

  for (const file of section.files) {
    lines.push(`  enabled  ${file}`);
  }
  return lines.join("\n");
}

export function formatLooseModsList(mods: LooseModsList): string {
  const sections: string[] = [];
  if (mods.agent) {
    sections.push(formatLooseModSection("Agent mods", mods.agent));
  }
  sections.push(formatLooseModSection("Harness mods", mods.harness));
  return sections.join("\n\n");
}

async function runList(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseModsArgs>;
  try {
    parsed = parseModsArgs(argv);
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

  const agentId = getExplicitAgentId(parsed.values);
  const mods = listLooseMods({ agentId });
  console.log(formatLooseModsList(mods));
  return 0;
}

export async function runModsSubcommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;

  if (!action || action === "help" || action === "--help" || action === "-h") {
    printUsage();
    return 0;
  }

  switch (action) {
    case "list":
      return runList(rest);
    default:
      console.error(`Unknown mods action: ${action}`);
      printUsage();
      return 1;
  }
}
