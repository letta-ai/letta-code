#!/usr/bin/env node

import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const COMMANDS = new Set([
  "cancel",
  "connections",
  "list",
  "subscribe",
  "types",
]);
const BOOLEAN_OPTIONS = new Set(["confirm"]);
const MAX_BODY_BYTES = 1024 * 1024;

function usage() {
  console.error(`Usage:
  node manage-managed-events.mjs connections
  node manage-managed-events.mjs types --service-id <service> --server-id <id> [--cursor <cursor>] [--limit <1-50>]
  node manage-managed-events.mjs list --service-id <service> --server-id <id> [--cursor <cursor>] [--limit <1-50>]
  node manage-managed-events.mjs subscribe --service-id <service> --server-id <id> --trigger-slug <slug> --webhook-id <id> [--config-file <path>] --confirm
  node manage-managed-events.mjs cancel --service-id <service> --server-id <id> --trigger-id <id> --confirm

Environment:
  LETTA_API_KEY   Required Cloud API credential from the active runtime
  LETTA_BASE_URL  Active server supplied by the runtime
  AGENT_ID        Required current agent; cannot be overridden
`);
  process.exit(2);
}

const COMMAND_OPTIONS = new Map([
  ["connections", new Set()],
  ["types", new Set(["cursor", "limit", "server-id", "service-id"])],
  ["list", new Set(["cursor", "limit", "server-id", "service-id"])],
  [
    "subscribe",
    new Set([
      "config-file",
      "confirm",
      "server-id",
      "service-id",
      "trigger-slug",
      "webhook-id",
    ]),
  ],
  ["cancel", new Set(["confirm", "server-id", "service-id", "trigger-id"])],
]);

export function parseManagedEventArgs(argv) {
  const [command = "", ...rest] = argv;
  if (!COMMANDS.has(command)) usage();
  const allowed = COMMAND_OPTIONS.get(command);
  if (!allowed) throw new Error(`Unsupported command: ${command}`);
  const args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--help" || option === "-h") usage();
    if (!option?.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${option ?? ""}`);
    }
    const key = option.slice(2);
    if (!allowed.has(key)) {
      throw new Error(`Unsupported option --${key} for ${command}`);
    }
    if (Object.hasOwn(args, key)) {
      throw new Error(`Duplicate option --${key}`);
    }
    if (BOOLEAN_OPTIONS.has(key)) {
      args[key] = true;
      continue;
    }
    const value = rest[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
  }
  return { args, command };
}

function requiredString(value, message) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function normalizedBaseUrl(value) {
  const parsed = new URL(
    requiredString(value, "LETTA_BASE_URL is required from the active runtime"),
  );
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("LETTA_BASE_URL must use http or https");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (parsed.protocol === "http:" && !loopback.has(parsed.hostname)) {
    throw new Error("Plaintext LETTA_BASE_URL is allowed only on loopback");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.toString().replace(/\/$/, "");
}

function positiveLimit(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("--limit must be an integer");
  const limit = Number(value);
  if (limit < 1 || limit > 50) {
    throw new Error("--limit must be between 1 and 50");
  }
  return limit;
}

async function readBoundedJsonObject(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (stat.size > MAX_BODY_BYTES) {
      throw new Error("Trigger configuration exceeds 1 MiB");
    }
    const text = await file.readFile("utf8");
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("Trigger configuration must be a JSON object");
    }
    return value;
  } finally {
    await file.close();
  }
}

async function readBoundedBody(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error("Cloud API response exceeds 1 MiB");
  }
  if (!response.body) return null;
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Cloud API response exceeds 1 MiB");
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Cloud API returned invalid JSON");
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeError(body, status) {
  return {
    status,
    error_code:
      isRecord(body) && typeof body.error_code === "string"
        ? body.error_code
        : "managed_event_request_failed",
    message:
      isRecord(body) && typeof body.message === "string"
        ? body.message
        : "Managed event request failed",
  };
}

function mutationAmbiguous(command, status, reason) {
  return {
    operation: command,
    status: "accepted_unconfirmed",
    ...(status ? { http_status: status } : {}),
    reason,
    guidance:
      command === "subscribe"
        ? "List subscriptions and reconcile the trigger slug, configuration, and webhook before retrying."
        : "List subscriptions and reconcile the trigger ID before retrying.",
  };
}

function managedPath(agentId, args, suffix) {
  const serviceId = requiredString(
    args["service-id"],
    "--service-id is required",
  );
  const serverId = requiredString(args["server-id"], "--server-id is required");
  return `/v1/agents/${encodeURIComponent(agentId)}/managed-mcp-connections/${encodeURIComponent(serviceId)}/${encodeURIComponent(serverId)}/${suffix}`;
}

function pageQuery(args) {
  const query = new URLSearchParams();
  const limit = positiveLimit(args.limit);
  if (limit) query.set("limit", String(limit));
  if (args.cursor)
    query.set(
      "cursor",
      requiredString(args.cursor, "--cursor must be non-empty"),
    );
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export async function runManagedEventCommand(parsed, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetch ?? fetch;
  const agentId = requiredString(
    env.AGENT_ID ?? env.LETTA_AGENT_ID,
    "AGENT_ID is required; this helper only manages the current agent",
  );
  const apiKey = requiredString(env.LETTA_API_KEY, "LETTA_API_KEY is required");
  const baseUrl = normalizedBaseUrl(env.LETTA_BASE_URL);
  const { args, command } = parsed;
  let path;
  let method = "GET";
  let body;

  if (command === "connections") {
    path = `/v1/agents/${encodeURIComponent(agentId)}/connections`;
  } else if (command === "types") {
    path = `${managedPath(agentId, args, "trigger-types")}${pageQuery(args)}`;
  } else if (command === "list") {
    path = `${managedPath(agentId, args, "trigger-subscriptions")}${pageQuery(args)}`;
  } else if (command === "subscribe") {
    if (!args.confirm) throw new Error("subscribe requires --confirm");
    method = "POST";
    path = managedPath(agentId, args, "trigger-subscriptions");
    body = {
      trigger_slug: requiredString(
        args["trigger-slug"],
        "--trigger-slug is required",
      ),
      webhook_id: requiredString(
        args["webhook-id"],
        "--webhook-id is required",
      ),
      ...(args["config-file"]
        ? { trigger_config: await readBoundedJsonObject(args["config-file"]) }
        : {}),
    };
  } else {
    if (!args.confirm) throw new Error("cancel requires --confirm");
    method = "DELETE";
    const triggerId = requiredString(
      args["trigger-id"],
      "--trigger-id is required",
    );
    path = managedPath(
      agentId,
      args,
      `trigger-subscriptions/${encodeURIComponent(triggerId)}`,
    );
  }

  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (method !== "GET") {
      return mutationAmbiguous(
        command,
        undefined,
        error instanceof Error ? error.message : "transport failure",
      );
    }
    throw error;
  }

  if (command === "cancel" && response.status === 204) {
    return { cancelled: true, trigger_id: args["trigger-id"] };
  }

  let responseBody;
  try {
    responseBody = await readBoundedBody(response);
  } catch (error) {
    if (method !== "GET" && response.ok) {
      return mutationAmbiguous(
        command,
        response.status,
        error instanceof Error ? error.message : "unreadable response",
      );
    }
    throw error;
  }

  if (!response.ok) {
    if (method !== "GET" && [408, 429].includes(response.status)) {
      return mutationAmbiguous(
        command,
        response.status,
        "non-definitive response",
      );
    }
    if (method !== "GET" && response.status >= 500) {
      return mutationAmbiguous(
        command,
        response.status,
        "provider result is unknown",
      );
    }
    const error = safeError(responseBody, response.status);
    throw Object.assign(new Error(error.message), { details: error });
  }

  if (!isRecord(responseBody)) {
    if (method !== "GET") {
      return mutationAmbiguous(
        command,
        response.status,
        "invalid success response",
      );
    }
    throw new Error("Cloud API returned an invalid response");
  }
  if (command === "connections") {
    const connections = Array.isArray(responseBody.connections)
      ? responseBody.connections
      : [];
    return {
      connections: connections.flatMap((connection) =>
        isRecord(connection) &&
        typeof connection.service === "string" &&
        typeof connection.mcp_server_id === "string"
          ? [
              {
                display_name:
                  typeof connection.display_name === "string"
                    ? connection.display_name
                    : connection.service,
                service_id: connection.service,
                mcp_server_id: connection.mcp_server_id,
              },
            ]
          : [],
      ),
    };
  }
  return responseBody;
}

async function main() {
  try {
    const result = await runManagedEventCommand(
      parseManagedEventArgs(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const details =
      isRecord(error) && isRecord(error.details) ? error.details : null;
    process.stderr.write(
      `${JSON.stringify(details ?? { error: { message: error instanceof Error ? error.message : String(error) } }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
