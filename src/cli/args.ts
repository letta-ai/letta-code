import { parseArgs } from "node:util";

export const CLI_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  info: { type: "boolean" },
  continue: { type: "boolean", short: "c" },
  resume: { type: "boolean", short: "r" },
  conversation: { type: "string", short: "C" },
  "new-agent": { type: "boolean" },
  new: { type: "boolean" },
  "init-blocks": { type: "string" },
  "base-tools": { type: "string" },
  agent: { type: "string", short: "a" },
  name: { type: "string", short: "n" },
  model: { type: "string", short: "m" },
  embedding: { type: "string" },
  system: { type: "string", short: "s" },
  "system-custom": { type: "string" },
  "system-append": { type: "string" },
  "memory-blocks": { type: "string" },
  "block-value": { type: "string", multiple: true },
  toolset: { type: "string" },
  prompt: { type: "boolean", short: "p" },
  run: { type: "boolean" },
  tools: { type: "string" },
  allowedTools: { type: "string" },
  disallowedTools: { type: "string" },
  "permission-mode": { type: "string" },
  yolo: { type: "boolean" },
  "output-format": { type: "string" },
  "input-format": { type: "string" },
  "include-partial-messages": { type: "boolean" },
  "from-agent": { type: "string" },
  skills: { type: "string" },
  "skill-sources": { type: "string" },
  "pre-load-skills": { type: "string" },
  "from-af": { type: "string" },
  import: { type: "string" },
  tags: { type: "string" },
  memfs: { type: "boolean" },
  "no-memfs": { type: "boolean" },
  "memfs-startup": { type: "string" },
  "no-skills": { type: "boolean" },
  "no-bundled-skills": { type: "boolean" },
  "no-system-info-reminder": { type: "boolean" },
  "reflection-trigger": { type: "string" },
  "reflection-behavior": { type: "string" },
  "reflection-step-count": { type: "string" },
  "max-turns": { type: "string" },
} as const;

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
