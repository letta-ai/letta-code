import { parseArgs } from "node:util";
import {
  estimateSystemPromptSize,
  type FileEstimate,
  type SystemPromptSizeEstimate,
} from "../../utils/systemPromptSize";

const DEFAULT_THRESHOLD_WARN = 20000;
const DEFAULT_THRESHOLD_FAIL = 25000;
const DEFAULT_TOP = 20;

const USAGE_EXIT = 64;
const IO_EXIT = 65;

function printUsage(): void {
  console.log(
    `
Usage:
  letta memory tokens [--memory-dir <path>] [--top <N>] [--format text|json]
                      [--threshold-warn <tokens>] [--threshold-fail <tokens>] [--quiet]

Flags:
  --memory-dir <path>     Path to an agent memory directory (contains system/).
                          Defaults to $MEMORY_DIR env var.
  --top <N>               Number of largest files to show (default 20; 0 to hide).
  --format text|json      Output format (default text).
  --threshold-warn <N>    Exit 1 when total tokens exceed this (default 20000).
  --threshold-fail <N>    Exit 2 when total tokens exceed this (default 25000).
  --quiet                 Suppress per-file breakdown (implies --top 0).

Exit codes:
  0   within target (<= --threshold-warn)
  1   over target (> warn, <= fail)
  2   significantly over (> fail)
  64  usage error
  65  I/O error (missing memory-dir or system/)

Examples:
  letta memory tokens
  letta memory tokens --memory-dir ~/.letta/agents/agent-123/memory
  letta memory tokens --format json --quiet
`.trim(),
  );
}

const MEMORY_OPTIONS = {
  help: { type: "boolean", short: "h" },
  "memory-dir": { type: "string" },
  top: { type: "string" },
  format: { type: "string" },
  "threshold-warn": { type: "string" },
  "threshold-fail": { type: "string" },
  quiet: { type: "boolean" },
} as const;

function parseMemoryArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: MEMORY_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number | null {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) {
    return null;
  }
  return value;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

type Status = "within_target" | "over_target" | "significantly_over";

function deriveStatus(
  total: number,
  warn: number,
  fail: number,
): { status: Status; exitCode: 0 | 1 | 2 } {
  if (total > fail) {
    return { status: "significantly_over", exitCode: 2 };
  }
  if (total > warn) {
    return { status: "over_target", exitCode: 1 };
  }
  return { status: "within_target", exitCode: 0 };
}

function statusLabel(status: Status): string {
  switch (status) {
    case "within_target":
      return "within target";
    case "over_target":
      return "over target";
    case "significantly_over":
      return "significantly over target";
  }
}

function printText(
  total: number,
  files: FileEstimate[],
  status: Status,
  warn: number,
  fail: number,
  top: number,
  quiet: boolean,
): void {
  console.log("System prompt token estimate");
  console.log(`  Total: ${formatNumber(total)} tokens`);
  console.log(
    `  Target: <=${formatNumber(warn)} (warn) / <=${formatNumber(fail)} (fail)`,
  );
  console.log(`  Status: ${statusLabel(status)}`);

  if (quiet || top <= 0 || files.length === 0) {
    return;
  }

  const ranked = [...files].sort((a, b) => b.tokens - a.tokens);
  const limited = ranked.slice(0, top);

  console.log("");
  console.log("Top files:");
  console.log(`  ${"tokens".padStart(8)}  path`);
  for (const row of limited) {
    console.log(`  ${formatNumber(row.tokens).padStart(8)}  ${row.path}`);
  }
}

function printJson(
  total: number,
  files: FileEstimate[],
  status: Status,
  warn: number,
  fail: number,
): void {
  console.log(
    JSON.stringify(
      {
        total_tokens: total,
        threshold_warn: warn,
        threshold_fail: fail,
        status,
        files,
      },
      null,
      2,
    ),
  );
}

async function runTokensAction(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseMemoryArgs>;
  try {
    parsed = parseMemoryArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    printUsage();
    return USAGE_EXIT;
  }

  if (parsed.values.help) {
    printUsage();
    return 0;
  }

  const memoryDir = parsed.values["memory-dir"] || process.env.MEMORY_DIR || "";
  if (!memoryDir) {
    console.error("Missing memory dir. Pass --memory-dir or set MEMORY_DIR.");
    printUsage();
    return USAGE_EXIT;
  }

  const format = parsed.values.format ?? "text";
  if (format !== "text" && format !== "json") {
    console.error(`Invalid --format: ${format} (expected text or json)`);
    return USAGE_EXIT;
  }

  const quiet = Boolean(parsed.values.quiet);
  const top = parsePositiveInt(parsed.values.top, DEFAULT_TOP);
  if (top === null) {
    console.error(
      `Invalid --top: ${parsed.values.top} (expected non-negative integer)`,
    );
    return USAGE_EXIT;
  }

  const warn = parsePositiveInt(
    parsed.values["threshold-warn"],
    DEFAULT_THRESHOLD_WARN,
  );
  const fail = parsePositiveInt(
    parsed.values["threshold-fail"],
    DEFAULT_THRESHOLD_FAIL,
  );
  if (warn === null) {
    console.error(`Invalid --threshold-warn: expected non-negative integer`);
    return USAGE_EXIT;
  }
  if (fail === null) {
    console.error(`Invalid --threshold-fail: expected non-negative integer`);
    return USAGE_EXIT;
  }
  if (fail < warn) {
    console.error(
      `Invalid thresholds: --threshold-fail (${fail}) must be >= --threshold-warn (${warn})`,
    );
    return USAGE_EXIT;
  }

  let estimate: SystemPromptSizeEstimate;
  try {
    estimate = estimateSystemPromptSize(memoryDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read memory dir: ${message}`);
    return IO_EXIT;
  }

  const { total, files } = estimate;
  const { status, exitCode } = deriveStatus(total, warn, fail);

  if (format === "json") {
    printJson(total, files, status, warn, fail);
  } else {
    printText(total, files, status, warn, fail, top, quiet);
  }

  return exitCode;
}

export async function runMemorySubcommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;

  if (!action || action === "help" || action === "--help" || action === "-h") {
    printUsage();
    return 0;
  }

  if (action === "tokens") {
    return runTokensAction(rest);
  }

  console.error(`Unknown action: ${action}`);
  printUsage();
  return USAGE_EXIT;
}
