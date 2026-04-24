import { parseArgs } from "node:util";
import {
  estimateSystemPromptSize,
  type FileEstimate,
  type SystemPromptSizeEstimate,
} from "../../utils/systemPromptSize";

const DEFAULT_TOP = 20;

const USAGE_EXIT = 64;
const IO_EXIT = 65;

function printUsage(): void {
  console.log(
    `
Usage:
  letta memory tokens [--memory-dir <path>] [--top <N>] [--format text|json] [--quiet]

Reports the estimated token size of an agent's system/ memory directory.
Policy (whether a size is concerning) is up to the caller.

Flags:
  --memory-dir <path>     Path to an agent memory directory (contains system/).
                          Defaults to $MEMORY_DIR env var.
  --top <N>               Number of largest files to show (default 20; 0 to hide).
  --format text|json      Output format (default text).
  --quiet                 Suppress per-file breakdown (implies --top 0).

Exit codes:
  0   success
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

function printText(
  total: number,
  files: FileEstimate[],
  top: number,
  quiet: boolean,
): void {
  console.log("System prompt token estimate");
  console.log(`  Total: ${formatNumber(total)} tokens`);

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

function printJson(total: number, files: FileEstimate[]): void {
  console.log(
    JSON.stringify(
      {
        total_tokens: total,
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

  let estimate: SystemPromptSizeEstimate;
  try {
    estimate = estimateSystemPromptSize(memoryDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read memory dir: ${message}`);
    return IO_EXIT;
  }

  const { total, files } = estimate;

  if (format === "json") {
    printJson(total, files);
  } else {
    printText(total, files, top, quiet);
  }

  return 0;
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
