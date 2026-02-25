import { parseArgs } from "node:util";

export type CliFlagMode = "interactive" | "headless" | "both";

type CliFlagParserConfig = {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
};

interface CliFlagDefinition {
  parser: CliFlagParserConfig;
  mode: CliFlagMode;
}

export const CLI_FLAG_CATALOG = {
  help: { parser: { type: "boolean", short: "h" }, mode: "both" },
  version: { parser: { type: "boolean", short: "v" }, mode: "both" },
  info: { parser: { type: "boolean" }, mode: "both" },
  continue: { parser: { type: "boolean", short: "c" }, mode: "both" },
  resume: { parser: { type: "boolean", short: "r" }, mode: "interactive" },
  conversation: { parser: { type: "string", short: "C" }, mode: "both" },
  "new-agent": { parser: { type: "boolean" }, mode: "both" },
  new: { parser: { type: "boolean" }, mode: "both" },
  "init-blocks": { parser: { type: "string" }, mode: "both" },
  "base-tools": { parser: { type: "string" }, mode: "both" },
  agent: { parser: { type: "string", short: "a" }, mode: "both" },
  name: { parser: { type: "string", short: "n" }, mode: "both" },
  model: { parser: { type: "string", short: "m" }, mode: "both" },
  embedding: { parser: { type: "string" }, mode: "both" },
  system: { parser: { type: "string", short: "s" }, mode: "both" },
  "system-custom": { parser: { type: "string" }, mode: "both" },
  "system-append": { parser: { type: "string" }, mode: "headless" },
  "memory-blocks": { parser: { type: "string" }, mode: "both" },
  "block-value": {
    parser: { type: "string", multiple: true },
    mode: "headless",
  },
  toolset: { parser: { type: "string" }, mode: "both" },
  prompt: { parser: { type: "boolean", short: "p" }, mode: "headless" },
  run: { parser: { type: "boolean" }, mode: "headless" },
  tools: { parser: { type: "string" }, mode: "both" },
  allowedTools: { parser: { type: "string" }, mode: "both" },
  disallowedTools: { parser: { type: "string" }, mode: "both" },
  "permission-mode": { parser: { type: "string" }, mode: "both" },
  yolo: { parser: { type: "boolean" }, mode: "both" },
  "output-format": { parser: { type: "string" }, mode: "headless" },
  "input-format": { parser: { type: "string" }, mode: "headless" },
  "include-partial-messages": {
    parser: { type: "boolean" },
    mode: "headless",
  },
  "from-agent": { parser: { type: "string" }, mode: "headless" },
  skills: { parser: { type: "string" }, mode: "both" },
  "skill-sources": { parser: { type: "string" }, mode: "both" },
  "pre-load-skills": { parser: { type: "string" }, mode: "headless" },
  "from-af": { parser: { type: "string" }, mode: "both" },
  import: { parser: { type: "string" }, mode: "both" },
  tags: { parser: { type: "string" }, mode: "headless" },
  memfs: { parser: { type: "boolean" }, mode: "both" },
  "no-memfs": { parser: { type: "boolean" }, mode: "both" },
  "memfs-startup": { parser: { type: "string" }, mode: "headless" },
  "no-skills": { parser: { type: "boolean" }, mode: "both" },
  "no-bundled-skills": { parser: { type: "boolean" }, mode: "both" },
  "no-system-info-reminder": { parser: { type: "boolean" }, mode: "both" },
  "reflection-trigger": { parser: { type: "string" }, mode: "both" },
  "reflection-behavior": { parser: { type: "string" }, mode: "both" },
  "reflection-step-count": { parser: { type: "string" }, mode: "both" },
  "max-turns": { parser: { type: "string" }, mode: "headless" },
} as const satisfies Record<string, CliFlagDefinition>;

export const CLI_OPTIONS: Record<string, CliFlagParserConfig> =
  Object.fromEntries(
    Object.entries(CLI_FLAG_CATALOG).map(([name, definition]) => [
      name,
      definition.parser,
    ]),
  );

export function getCliFlagsForMode(mode: Exclude<CliFlagMode, "both">): string[] {
  return Object.entries(CLI_FLAG_CATALOG)
    .filter(([, definition]) => definition.mode === "both" || definition.mode === mode)
    .map(([name]) => name);
}

export function preprocessCliArgs(args: string[]): string[] {
  return args.map((arg) => (arg === "--conv" ? "--conversation" : arg));
}

export function parseCliArgs(args: string[], strict: boolean) {
  return parseArgs({
    args,
    options: CLI_OPTIONS,
    strict,
    allowPositionals: true,
  });
}

export type ParsedCliArgs = ReturnType<typeof parseCliArgs>;
