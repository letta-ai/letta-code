import { parseArgs } from "node:util";

export type CliFlagMode = "interactive" | "headless" | "both";
export type CliBackendMode = "api" | "local";

type CliFlagParserConfig = {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
};

type CliFlagHelpConfig = {
  argLabel?: string;
  description: string;
  continuationLines?: string[];
};

interface CliFlagDefinition {
  parser: CliFlagParserConfig;
  mode: CliFlagMode;
  help?: CliFlagHelpConfig;
}

export const CLI_FLAG_CATALOG = {
  help: {
    parser: { type: "boolean", short: "h" },
    mode: "both",
    help: { description: "Show this help and exit" },
  },
  version: {
    parser: { type: "boolean", short: "v" },
    mode: "both",
    help: { description: "Print version and exit" },
  },
  info: {
    parser: { type: "boolean" },
    mode: "both",
    help: { description: "Show current directory, skills, and pinned agents" },
  },
  resume: {
    parser: { type: "boolean", short: "r" },
    mode: "interactive",
    help: { description: "Open agent selector UI after loading" },
  },
  conversation: { parser: { type: "string", short: "C" }, mode: "both" },
  "new-agent": {
    parser: { type: "boolean" },
    mode: "both",
    help: { description: "Create new agent directly (skip profile selection)" },
  },
  new: {
    parser: { type: "boolean" },
    mode: "both",
    help: { description: "Create new conversation (for concurrent sessions)" },
  },
  "base-tools": {
    parser: { type: "string" },
    mode: "both",
    help: {
      argLabel: "<list>",
      description:
        'Comma-separated base tools to attach when using --new-agent (e.g., "memory,web_search,fetch_webpage")',
    },
  },
  agent: {
    parser: { type: "string", short: "a" },
    mode: "both",
    help: { argLabel: "<id>", description: "Use a specific agent ID" },
  },
  name: {
    parser: { type: "string", short: "n" },
    mode: "both",
    help: {
      argLabel: "<name>",
      description:
        "Resume agent by name (from pinned agents, case-insensitive)",
    },
  },
  model: {
    parser: { type: "string", short: "m" },
    mode: "both",
    help: {
      argLabel: "<id>",
      description:
        'Model ID or handle (e.g., "opus-4.5" or "anthropic/claude-opus-4-5")',
    },
  },
  embedding: { parser: { type: "string" }, mode: "both" },
  system: {
    parser: { type: "string", short: "s" },
    mode: "both",
    help: {
      argLabel: "<id>",
      description: "System prompt preset ID (applies to new or existing agent)",
    },
  },
  "system-custom": { parser: { type: "string" }, mode: "both" },
  personality: {
    parser: { type: "string" },
    mode: "both",
    help: {
      argLabel: "<name>",
      description:
        'Personality preset for --new-agent: "letta-code", "tutorial", "blank", "linus", "kawaii", "claude", or "codex"',
    },
  },
  toolset: {
    parser: { type: "string" },
    mode: "both",
    help: {
      argLabel: "<name>",
      description:
        'Toolset mode: "auto", "codex", "default", or "gemini" (manual values override model-based auto-selection)',
    },
  },
  prompt: {
    parser: { type: "boolean", short: "p" },
    mode: "headless",
    help: { description: "Headless prompt mode" },
  },
  // Advanced/internal flags intentionally hidden from --help output.
  // They remain in the shared catalog for strict parsing parity.
  run: { parser: { type: "boolean" }, mode: "headless" },
  "dev-backend": { parser: { type: "string" }, mode: "headless" },
  backend: {
    parser: { type: "string" },
    mode: "both",
    help: {
      argLabel: "<mode>",
      description: 'Backend mode: "api" or "local"',
    },
  },
  tools: { parser: { type: "string" }, mode: "both" },
  allowedTools: { parser: { type: "string" }, mode: "both" },
  disallowedTools: { parser: { type: "string" }, mode: "both" },
  "permission-mode": { parser: { type: "string" }, mode: "both" },
  "disable-memory-guard": {
    parser: { type: "boolean" },
    mode: "headless",
    help: {
      description:
        "Disable the cross-agent memory guard for this parent agent process.",
      continuationLines: [
        "Allows intentional access to other agents' memory directories.",
        "Ignored by subagents; their memory guard remains enabled.",
      ],
    },
  },
  yolo: { parser: { type: "boolean" }, mode: "both" },
  "output-format": {
    parser: { type: "string" },
    mode: "headless",
    help: {
      argLabel: "<fmt>",
      description: "Output format for headless mode (text, json, stream-json)",
      continuationLines: ["Default: text"],
    },
  },
  "input-format": {
    parser: { type: "string" },
    mode: "headless",
    help: {
      argLabel: "<fmt>",
      description: "Input format for headless mode (stream-json)",
      continuationLines: [
        "When set, reads JSON messages from stdin for bidirectional communication",
      ],
    },
  },
  "include-partial-messages": {
    parser: { type: "boolean" },
    mode: "headless",
    help: {
      description:
        "Emit stream_event wrappers for each chunk (stream-json only)",
    },
  },
  "from-agent": {
    parser: { type: "string" },
    mode: "headless",
    help: {
      argLabel: "<id>",
      description: "Inject agent-to-agent system reminder (headless mode)",
    },
  },
  skills: {
    parser: { type: "string" },
    mode: "both",
    help: {
      argLabel: "<path>",
      description:
        "Custom path to skills directory (default: .skills in current directory)",
    },
  },
  "skill-sources": {
    parser: { type: "string" },
    mode: "both",
    help: {
      argLabel: "<csv>",
      description:
        "Skill sources: all,bundled,global,agent,project (default: all)",
    },
  },
  "pre-load-skills": { parser: { type: "string" }, mode: "headless" },
  // Legacy alias retained for backward compatibility; use --import in docs/errors.
  "from-af": { parser: { type: "string" }, mode: "both" },
  import: {
    parser: { type: "string" },
    mode: "both",
    help: {
      argLabel: "<path>",
      description: "Create agent from an AgentFile (.af) template",
      continuationLines: ["Use @author/name to import from the agent registry"],
    },
  },
  // Internal headless metadata tag assignment (not part of primary user help).
  tags: { parser: { type: "string" }, mode: "headless" },
  memfs: {
    parser: { type: "boolean" },
    mode: "both",
    help: { description: "Enable memory filesystem for this agent" },
  },
  // DEPRECATED no-op, intentionally hidden from help. Accepted for backward
  // compatibility: older parent processes (pre-mandatory-memfs) spawn
  // subagents with --no-memfs, and after an auto-update the child binary on
  // disk is newer than the still-running parent. Rejecting the flag broke
  // reflection subagents during that version skew (LET-9436). Subagent
  // statelessness now derives from LETTA_CODE_AGENT_ROLE=subagent, so the
  // flag is simply ignored.
  "no-memfs": {
    parser: { type: "boolean" },
    mode: "both",
  },
  "memfs-startup": {
    parser: { type: "string" },
    mode: "headless",
    help: {
      argLabel: "<m>",
      description:
        "Startup memfs pull policy for headless mode: blocking, background, or skip",
    },
  },
  "no-skills": {
    parser: { type: "boolean" },
    mode: "both",
    help: { description: "Disable all skill sources" },
  },
  "no-bundled-skills": {
    parser: { type: "boolean" },
    mode: "both",
    help: { description: "Disable bundled skills only" },
  },
  "no-system-info-reminder": {
    parser: { type: "boolean" },
    mode: "both",
    help: {
      description:
        "Disable first-turn environment reminder (device/git/cwd context)",
    },
  },
  "no-mods": {
    parser: { type: "boolean" },
    mode: "both",
    help: {
      description: "Disable local mods for this session",
      continuationLines: ["Recovery alias: LETTA_DISABLE_MODS=1 letta"],
    },
  },
  "reflection-trigger": {
    parser: { type: "string" },
    mode: "both",
    help: {
      argLabel: "<mode>",
      description:
        "Sleeptime trigger: off, step-count, compaction-event (requires memfs unless off)",
    },
  },
  "reflection-step-count": {
    parser: { type: "string" },
    mode: "both",
    help: {
      argLabel: "<n>",
      description: "Sleeptime step-count interval (positive integer)",
    },
  },
  "max-turns": { parser: { type: "string" }, mode: "headless" },
} as const satisfies Record<string, CliFlagDefinition>;

type CliFlagCatalog = typeof CLI_FLAG_CATALOG;

type CliCatalogOptionDescriptors = {
  [K in keyof CliFlagCatalog]: CliFlagCatalog[K]["parser"];
};

type CliParsedValueForDescriptor<Descriptor extends CliFlagParserConfig> =
  Descriptor["type"] extends "boolean"
    ? Descriptor["multiple"] extends true
      ? boolean[]
      : boolean
    : Descriptor["multiple"] extends true
      ? string[]
      : string;

export type CliParsedValues = {
  [K in keyof CliCatalogOptionDescriptors]?: CliParsedValueForDescriptor<
    CliCatalogOptionDescriptors[K]
  >;
};

const CLI_FLAG_ENTRIES = Object.entries(CLI_FLAG_CATALOG) as Array<
  [keyof CliFlagCatalog, CliFlagDefinition]
>;

export const CLI_OPTIONS = Object.fromEntries(
  CLI_FLAG_ENTRIES.map(([name, definition]) => [name, definition.parser]),
) as CliCatalogOptionDescriptors;
// Column width for left-aligned flag labels in generated --help output.
const HELP_LABEL_WIDTH = 24;

function formatHelpFlagLabel(
  flagName: string,
  definition: CliFlagDefinition,
): string {
  const argLabel = definition.help?.argLabel;
  const longName = `--${flagName}${argLabel ? ` ${argLabel}` : ""}`;
  const short = definition.parser.short;
  if (!short) {
    return longName;
  }
  return `-${short}, ${longName}`;
}

function formatHelpEntry(
  flagName: string,
  definition: CliFlagDefinition,
): string {
  const help = definition.help;
  if (!help) {
    return "";
  }

  const label = formatHelpFlagLabel(flagName, definition);
  const lines: string[] = [];
  const continuation = help.continuationLines ?? [];

  if (label.length >= HELP_LABEL_WIDTH) {
    lines.push(`  ${label}`);
    lines.push(`  ${"".padEnd(HELP_LABEL_WIDTH)}${help.description}`);
  } else {
    const spacing = " ".repeat(HELP_LABEL_WIDTH - label.length);
    lines.push(`  ${label}${spacing}${help.description}`);
  }

  for (const line of continuation) {
    lines.push(`  ${"".padEnd(HELP_LABEL_WIDTH)}${line}`);
  }
  return lines.join("\n");
}

export function renderCliOptionsHelp(): string {
  return CLI_FLAG_ENTRIES.filter(([, definition]) => Boolean(definition.help))
    .map(([flagName, definition]) => formatHelpEntry(flagName, definition))
    .filter((entry) => entry.length > 0)
    .join("\n");
}

export function preprocessCliArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (arg === "--conv") return "--conversation";
    if (arg === "--no-extensions") return "--no-mods";
    return arg;
  });
}

export function parseCliArgs(args: string[], strict: boolean) {
  const parsed = parseArgs({
    args,
    options: CLI_OPTIONS,
    strict,
    allowPositionals: true,
  });
  return {
    ...parsed,
    values: parsed.values as CliParsedValues,
  };
}

export type ParsedCliArgs = ReturnType<typeof parseCliArgs>;

export function parseBackendModeFlag(
  value: string | undefined,
): CliBackendMode | undefined {
  if (value === undefined) return undefined;
  if (value === "api" || value === "local") return value;
  throw new Error(
    `Invalid --backend value "${value}". Expected "api" or "local".`,
  );
}

export function extractBackendFlag(args: string[]): {
  backend?: CliBackendMode;
  args: string[];
} {
  const filtered: string[] = [];
  let backend: CliBackendMode | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--backend") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(
          'Missing value for --backend. Expected "api" or "local".',
        );
      }
      backend = parseBackendModeFlag(value);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--backend=")) {
      backend = parseBackendModeFlag(arg.slice("--backend=".length));
      continue;
    }
    filtered.push(arg);
  }

  return { backend, args: filtered };
}
