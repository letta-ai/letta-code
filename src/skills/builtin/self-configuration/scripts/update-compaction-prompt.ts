#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (["dry-run", "prompt-acknowledgement"].includes(key)) {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = value;
  }
  return out;
}

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/update-compaction-prompt.ts --prompt-file prompt.txt [options]

Options:
  --agent-id <id>                  Defaults to AGENT_ID
  --base-url <url>                 Defaults to LETTA_BASE_URL or https://api.letta.com
  --mode <mode>                    sliding_window | all | self_compact_sliding_window | self_compact_all
  --model <provider/model>         Optional summarizer model
  --clip-chars <int|null>          Optional summary character cap
  --sliding-window-percentage <n>  Optional fraction for sliding-window modes
  --prompt-acknowledgement         Set prompt_acknowledgement=true
  --dry-run                        Fetch current settings and print patch body without PATCHing
`);
  process.exit(2);
}

async function requestJson(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  }
  return body as Record<string, unknown>;
}

const VALID_MODES = new Set([
  "sliding_window",
  "all",
  "self_compact_sliding_window",
  "self_compact_all",
]);

function parseIntegerOption(name: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`--${name} must be a non-negative integer or null`);
  }
  return Number.parseInt(value, 10);
}

function parseNumberOption(name: string, value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a number`);
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["prompt-file"]) usage();

  const dryRun = args["dry-run"] === true;

  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) {
    throw new Error(
      dryRun
        ? "Set LETTA_API_KEY for merge-preserving dry runs"
        : "Set LETTA_API_KEY",
    );
  }

  const agentId = String(args["agent-id"] || process.env.AGENT_ID || "");
  if (!agentId) throw new Error("Set AGENT_ID or pass --agent-id");

  const baseUrl = String(
    args["base-url"] || process.env.LETTA_BASE_URL || "https://api.letta.com",
  ).replace(/\/$/, "");
  const promptFile = String(args["prompt-file"]);
  if (!existsSync(promptFile)) {
    throw new Error(`Prompt file not found: ${promptFile}`);
  }
  const prompt = readFileSync(promptFile, "utf8");
  if (!prompt.trim()) throw new Error("Prompt file is empty");

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const currentAgent = await requestJson(`${baseUrl}/v1/agents/${agentId}`, {
    headers,
  });
  const currentSettings = (currentAgent.compaction_settings ?? {}) as Record<
    string,
    unknown
  >;

  const nextSettings: Record<string, unknown> = { ...currentSettings, prompt };

  if (args.mode) {
    const mode = String(args.mode);
    if (!VALID_MODES.has(mode)) {
      throw new Error(`Invalid --mode: ${mode}`);
    }
    nextSettings.mode = mode;
  }
  if (args.model) nextSettings.model = args.model;
  if (args["prompt-acknowledgement"])
    nextSettings.prompt_acknowledgement = true;
  if (args["clip-chars"] !== undefined) {
    const raw = String(args["clip-chars"]);
    nextSettings.clip_chars =
      raw === "null" ? null : parseIntegerOption("clip-chars", raw);
  }
  if (args["sliding-window-percentage"] !== undefined) {
    nextSettings.sliding_window_percentage = parseNumberOption(
      "sliding-window-percentage",
      String(args["sliding-window-percentage"]),
    );
  }

  const patch = { compaction_settings: nextSettings };

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          agent_id: agentId,
          preview: "effective_merged_patch",
          patch,
        },
        null,
        2,
      ),
    );
    return;
  }

  const updated = await requestJson(`${baseUrl}/v1/agents/${agentId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(patch),
  });

  console.log(
    JSON.stringify(
      {
        id: updated.id,
        compaction_settings: updated.compaction_settings,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
