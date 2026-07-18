#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";

type Args = Record<string, string | boolean>;
type JsonObject = Record<string, unknown>;

const SECRET_FIELD_PATTERN =
  /api[_-]?key|access[_-]?key|secret|token|credential|password|authorization/i;

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
  --merge-model-settings              Merge file into current model_settings; fetches current state
  --system-file <path>                Full replacement system prompt (agent target only)
  --compaction-settings-file <json>   JSON object for compaction_settings (agent target only)
  --merge-compaction-settings         Merge file into current compaction_settings; fetches current state
  --allow-other-agent                 Permit server operations on a different agent/conversation than the current env ID
  --confirm-system-replacement        Required for live non-dry-run --system-file writes
  --show                              GET and print safe effective fields only
  --dry-run                           Print patch body without PATCHing
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
      [
        "dry-run",
        "merge-model-settings",
        "merge-compaction-settings",
        "allow-other-agent",
        "confirm-system-replacement",
        "show",
      ].includes(key)
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

function redactSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretFields);
  if (!value || typeof value !== "object") return value;

  const output: JsonObject = {};
  for (const [key, nested] of Object.entries(value as JsonObject)) {
    output[key] = SECRET_FIELD_PATTERN.test(key)
      ? "[redacted]"
      : redactSecretFields(nested);
  }
  return output;
}

function safeLlmConfig(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = value as JsonObject;
  if (source.context_window === undefined) return undefined;
  return { context_window: source.context_window };
}

function safeServerFields(value: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const key of [
    "id",
    "name",
    "description",
    "model",
    "context_window_limit",
  ]) {
    if (value[key] !== undefined) output[key] = value[key];
  }

  const agentId = value.agent_id ?? value.agentId;
  if (agentId !== undefined) output.agent_id = agentId;

  const llmConfig = safeLlmConfig(value.llm_config);
  if (llmConfig) output.llm_config = llmConfig;
  if (value.model_settings !== undefined) {
    output.model_settings = redactSecretFields(value.model_settings);
  }
  if (value.compaction_settings !== undefined) {
    output.compaction_settings = redactSecretFields(value.compaction_settings);
  }
  return output;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = String(args.target ?? "");
  if (target !== "agent" && target !== "conversation") usage();

  const dryRun = args["dry-run"] === true;
  const show = args.show === true;
  const allowOtherAgent = args["allow-other-agent"] === true;
  const confirmSystemReplacement = args["confirm-system-replacement"] === true;
  const baseUrl = String(
    args["base-url"] || process.env.LETTA_BASE_URL || "https://api.letta.com",
  ).replace(/\/$/, "");
  const apiKey = process.env.LETTA_API_KEY;
  const mergeModelSettings = args["merge-model-settings"] === true;
  const mergeCompactionSettings = args["merge-compaction-settings"] === true;
  const updateFlagNames = [
    "name",
    "description",
    "model",
    "context-window-limit",
    "model-settings-file",
    "merge-model-settings",
    "system-file",
    "compaction-settings-file",
    "merge-compaction-settings",
  ].filter((key) => args[key] !== undefined);

  if (show) {
    const invalidFlagNames = [
      ...updateFlagNames,
      ...(dryRun ? ["dry-run"] : []),
      ...(confirmSystemReplacement ? ["confirm-system-replacement"] : []),
    ];
    if (invalidFlagNames.length > 0) {
      throw new Error(
        `--show cannot be combined with --${invalidFlagNames.join(", --")}`,
      );
    }
  }

  if (
    confirmSystemReplacement &&
    (dryRun || args["system-file"] === undefined)
  ) {
    throw new Error(
      "--confirm-system-replacement is only valid for live --system-file writes",
    );
  }

  if (mergeModelSettings && !args["model-settings-file"]) {
    throw new Error("--merge-model-settings requires --model-settings-file");
  }
  if (mergeCompactionSettings && !args["compaction-settings-file"]) {
    throw new Error(
      "--merge-compaction-settings requires --compaction-settings-file",
    );
  }

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

  if (
    !dryRun &&
    args["system-file"] !== undefined &&
    !confirmSystemReplacement
  ) {
    throw new Error(
      "Live --system-file writes require --confirm-system-replacement; use --dry-run to preview without confirmation",
    );
  }

  const needsCurrent = show || mergeModelSettings || mergeCompactionSettings;
  const usesServer = needsCurrent || !dryRun;
  const currentId =
    target === "agent" ? process.env.AGENT_ID : process.env.CONVERSATION_ID;
  const currentIdName = target === "agent" ? "AGENT_ID" : "CONVERSATION_ID";
  const idFlagName = target === "agent" ? "agent-id" : "conversation-id";
  const targetMismatch = Boolean(currentId && id !== currentId);

  if (allowOtherAgent && (!usesServer || !targetMismatch)) {
    throw new Error(
      "--allow-other-agent is only valid when a server operation targets a different agent/conversation than the current env ID",
    );
  }
  if (targetMismatch && usesServer && !allowOtherAgent) {
    throw new Error(
      `Refusing to target ${target} ${id} because ${currentIdName} is ${currentId}. Pass --allow-other-agent only after verifying the cross-${target} operation is intentional. If ${currentIdName} is unset, explicit --${idFlagName} remains allowed for out-of-band recovery.`,
    );
  }

  if (usesServer && !apiKey) {
    throw new Error(
      show
        ? "Set LETTA_API_KEY for --show"
        : needsCurrent && dryRun
          ? "Set LETTA_API_KEY for merge-preserving dry runs"
          : "Set LETTA_API_KEY",
    );
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  let current: JsonObject = {};
  if (needsCurrent) {
    current = await requestJson(
      `${baseUrl}/v1/${target === "agent" ? "agents" : "conversations"}/${id}`,
      { headers },
    );
  }

  if (show) {
    console.log(JSON.stringify(safeServerFields(current), null, 2));
    return;
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
    patch.model_settings = mergeModelSettings
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
    patch.compaction_settings = mergeCompactionSettings
      ? {
          ...((current.compaction_settings as JsonObject | undefined) ?? {}),
          ...next,
        }
      : next;
  }

  if (Object.keys(patch).length === 0)
    throw new Error("No settings requested; pass at least one update flag");

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          target,
          id,
          preview: needsCurrent
            ? "effective_merged_patch"
            : "offline_partial_patch",
          patch,
        },
        null,
        2,
      ),
    );
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

  console.log(JSON.stringify(safeServerFields(updated), null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
