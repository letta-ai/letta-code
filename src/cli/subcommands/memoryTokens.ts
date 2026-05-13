import {
  estimateSystemPromptSize,
  type FileEstimate,
  type SystemPromptSizeEstimate,
} from "../../utils/systemPromptSize";

const DEFAULT_TOP = 20;
const USAGE_EXIT = 64;
const IO_EXIT = 65;

export interface MemoryTokensOptions {
  memoryDir: string | undefined;
  agentMemoryDir: string | undefined;
  top: string | undefined;
  format: string | undefined;
  quiet: boolean;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
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

function resolveMemoryDir(options: MemoryTokensOptions): string | null {
  if (options.memoryDir) return options.memoryDir;
  if (process.env.MEMORY_DIR) return process.env.MEMORY_DIR;
  if (options.agentMemoryDir) return options.agentMemoryDir;
  return null;
}

export async function runMemoryTokensAction(
  options: MemoryTokensOptions,
): Promise<number> {
  const format = options.format ?? "text";
  if (format !== "text" && format !== "json") {
    console.error(`Invalid --format: ${format} (expected text or json)`);
    return USAGE_EXIT;
  }

  const top = parsePositiveInt(options.top, DEFAULT_TOP);
  if (top === null) {
    console.error(
      `Invalid --top: ${options.top} (expected non-negative integer)`,
    );
    return USAGE_EXIT;
  }

  const memoryDir = resolveMemoryDir(options);
  if (!memoryDir) {
    console.error(
      "Missing memory dir. Set --memory-dir, --agent, $MEMORY_DIR, or $LETTA_AGENT_ID.",
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
    printText(total, files, top, options.quiet);
  }
  return 0;
}
