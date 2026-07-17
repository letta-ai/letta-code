#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";

type Args = Record<string, string | boolean>;
type JsonObject = Record<string, unknown>;

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/update-agent-settings.ts --target agent|conversation [options]

Options:
  --target <agent|conversation>       Required
  --agent-id <id>                     Defaults to AGENT_ID
  --conversation-id <id>              Defaults to CONVERSATION_ID
  --base-url <url>                    Defaults to LETTA_BASE_URL or https://api.letta.com
  --name <name>                       Rename the agent (agent target only)
  --description <text>                Update agent description (agent target only)
  --model <provider/model>            Model handle
  --context-window-limit <int|null>   Top-level context_window_limit
  --model-settings-file <json>        JSON object for model_settings
  --merge-model-settings              Merge file into current model_settings instead of replacing
  --system-file <path>                Full replacement system prompt (agent target only)
  --compaction-settings-file <json>   JSON object for compaction_settings (agent target only)
  --merge-compaction-settings         Merge file into current compaction_settings instead of replacing
  --dry-run                           Print patch body without sending
`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--"))
      throw new Error(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2);
    if (
      ["dry-run", "merge-model-settings", "merge-compaction-settings"].includes(
        key,
      )
    ) {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for --${key}`);
    out[key] = value;
  }
  return out;
}

async function requestJson(
  url: string,
  init: RequestInit,
): Promise<JsonObject> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const rendered = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${rendered}`,
    );
  }
  return (body ?? {}) as JsonObject;
}

function readJsonObject(path: string): JsonObject {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as JsonObject;
}

function parseContextWindow(raw: string): number | null {
  if (raw === "null") return null;
  if (!/^\d+$/.test(raw))
    throw new Error("--context-window-limit must be an integer or null");
  return Number.parseInt(raw, 10);
}

function requireString(value: unknown, message: string): string {
  const str = String(value ?? "");
  if (!str) throw new Error(message);
  return str;
}

function optionalNonEmptyString(args: Args, key: string): string | undefined {
  if (args[key] === undefined) return undefined;
  const value = String(args[key]);
  if (!value.trim()) throw new Error(`--${key} must be non-empty`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = String(args.target ?? "");
  if (target !== "agent" && target !== "conversation") usage();

  const dryRun = args["dry-run"] === true;
  const baseUrl = String(
    args["base-url"] || process.env.LETTA_BASE_URL || "https://api.letta.com",
  ).replace(/\/$/, "");
  const apiKey = process.env.LETTA_API_KEY;
  if (!dryRun && !apiKey) throw new Error("Set LETTA_API_KEY");
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const id =
    target === "agent"
      ? requireString(
          args["agent-id"] || process.env.AGENT_ID,
          "Set AGENT_ID or pass --agent-id",
        )
      : requireString(
          args["conversation-id"] || process.env.CONVERSATION_ID,
          "Set CONVERSATION_ID or pass --conversation-id",
        );

  if (
    target === "conversation" &&
    (args.name !== undefined ||
      args.description !== undefined ||
      args["system-file"] !== undefined ||
      args["compaction-settings-file"] !== undefined)
  ) {
    throw new Error(
      "name, description, system, and compaction settings are agent-level only",
    );
  }

  let current: JsonObject = {};
  const needsCurrent =
    !dryRun &&
    (args["merge-model-settings"] || args["merge-compaction-settings"]);
  if (needsCurrent) {
    current = await requestJson(
      `${baseUrl}/v1/${target === "agent" ? "agents" : "conversations"}/${id}`,
      { headers },
    );
  }

  const patch: JsonObject = {};

  const name = optionalNonEmptyString(args, "name");
  if (name !== undefined) patch.name = name;
  const description = optionalNonEmptyString(args, "description");
  if (description !== undefined) patch.description = description;

  if (args.model) patch.model = String(args.model);
  if (args["context-window-limit"] !== undefined) {
    patch.context_window_limit = parseContextWindow(
      String(args["context-window-limit"]),
    );
  }

  if (args["model-settings-file"]) {
    const next = readJsonObject(String(args["model-settings-file"]));
    patch.model_settings = args["merge-model-settings"]
      ? {
          ...((current.model_settings as JsonObject | undefined) ?? {}),
          ...next,
        }
      : next;
  }

  if (args["system-file"]) {
    const systemPath = String(args["system-file"]);
    if (!existsSync(systemPath))
      throw new Error(`File not found: ${systemPath}`);
    const system = readFileSync(systemPath, "utf8");
    if (!system.trim()) throw new Error("System prompt file is empty");
    patch.system = system;
  }

  if (args["compaction-settings-file"]) {
    const next = readJsonObject(String(args["compaction-settings-file"]));
    patch.compaction_settings = args["merge-compaction-settings"]
      ? {
          ...((current.compaction_settings as JsonObject | undefined) ?? {}),
          ...next,
        }
      : next;
  }

  if (Object.keys(patch).length === 0)
    throw new Error("No settings requested; pass at least one update flag");

  if (dryRun) {
    console.log(JSON.stringify({ target, id, patch }, null, 2));
    return;
  }

  const updated = await requestJson(
    `${baseUrl}/v1/${target === "agent" ? "agents" : "conversations"}/${id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(patch),
    },
  );

  console.log(
    JSON.stringify(
      {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        model: updated.model,
        context_window_limit: updated.context_window_limit,
        llm_config: updated.llm_config,
        model_settings: updated.model_settings,
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
