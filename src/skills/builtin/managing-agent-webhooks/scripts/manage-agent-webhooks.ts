#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Args = Record<string, string | boolean>;
type JsonObject = Record<string, unknown>;

interface AgentWebhook extends JsonObject {
  id: string;
  webhook_url: string;
  requires_authorization_header: boolean;
}

const COMMANDS = new Set([
  "create",
  "delete",
  "disable",
  "enable",
  "list",
  "requests",
  "rotate",
  "test",
]);

function usage(): never {
  console.error(`Usage:
  node manage-agent-webhooks.ts list [--agent-id <id>] [--base-url <url>]
  node manage-agent-webhooks.ts create --name <name> (--public | --security-key-stdin) [--preprompt <text>] [--disabled]
  node manage-agent-webhooks.ts test --webhook-id <id> [--payload-json <json> | --payload-file <path>] [--security-key-stdin]
  node manage-agent-webhooks.ts requests --webhook-id <id> [--limit <1-50>] [--include-body]
  node manage-agent-webhooks.ts enable --webhook-id <id>
  node manage-agent-webhooks.ts disable --webhook-id <id> --confirm
  node manage-agent-webhooks.ts rotate --webhook-id <id> --confirm
  node manage-agent-webhooks.ts delete --webhook-id <id> --confirm

Environment:
  LETTA_API_KEY   Required for management operations
  LETTA_BASE_URL  Required unless --base-url is provided
  AGENT_ID        Current agent; used unless --agent-id is provided
`);
  process.exit(2);
}

export function parseAgentWebhookArgs(argv: string[]): {
  args: Args;
  command: string;
} {
  const [command = "", ...rest] = argv;
  if (!COMMANDS.has(command)) usage();

  const booleanFlags = new Set([
    "confirm",
    "disabled",
    "include-body",
    "public",
    "security-key-stdin",
  ]);
  const args: Args = {};
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === undefined) {
      throw new Error("Unexpected end of arguments");
    }
    if (argument === "--help" || argument === "-h") usage();
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }
    const key = argument.slice(2);
    if (booleanFlags.has(key)) {
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

function requireString(value: unknown, message: string): string {
  const stringValue = String(value ?? "").trim();
  if (!stringValue) throw new Error(message);
  return stringValue;
}

export function resolveAgentWebhookTarget(params: {
  currentAgentId?: string;
  requestedAgentId?: string;
}): string {
  const requested = params.requestedAgentId?.trim();
  const current = params.currentAgentId?.trim();
  if (requested && current && requested !== current) {
    throw new Error(
      `Refusing to manage ${requested}; the current agent is ${current}`,
    );
  }
  return requireString(
    requested || current,
    "Set AGENT_ID or pass --agent-id for the current agent",
  );
}

export function safeAgentWebhook(webhook: JsonObject): JsonObject {
  const {
    authorization_header: _authorizationHeader,
    webhook_slug: _webhookSlug,
    ...safe
  } = webhook;
  return safe;
}

export function buildAgentWebhookBasicAuthorization(
  securityKey: string,
): string {
  if (!securityKey) throw new Error("Security key must be non-empty");
  return `Basic ${Buffer.from(`webhook:${securityKey}`, "utf8").toString("base64")}`;
}

function normalizedBaseUrl(value: unknown): string {
  const baseUrl = requireString(
    value,
    "Set LETTA_BASE_URL or pass --base-url; do not guess the active server",
  );
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Base URL must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body = await parseResponse(response);
  if (!response.ok) {
    const rendered = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${rendered}`,
    );
  }
  return body;
}

function jsonObject(value: unknown, message: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as JsonObject;
}

function webhookFromUnknown(value: unknown): AgentWebhook {
  const webhook = jsonObject(value, "Webhook response must be an object");
  const id = requireString(webhook.id, "Webhook response is missing id");
  const webhookUrl = requireString(
    webhook.webhook_url,
    "Webhook response is missing webhook_url",
  );
  if (typeof webhook.requires_authorization_header !== "boolean") {
    throw new Error(
      "Webhook response is missing requires_authorization_header",
    );
  }
  return {
    ...webhook,
    id,
    webhook_url: webhookUrl,
    requires_authorization_header: webhook.requires_authorization_header,
  };
}

function webhookList(value: unknown): AgentWebhook[] {
  const body = jsonObject(value, "Webhook list response must be an object");
  if (!Array.isArray(body.webhooks)) {
    throw new Error("Webhook list response is missing webhooks");
  }
  return body.webhooks.map(webhookFromUnknown);
}

async function readSecurityKey(args: Args): Promise<string | undefined> {
  if (args["security-key-stdin"] !== true) return undefined;
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  value = value.replace(/[\r\n]+$/, "");
  if (!value) throw new Error("Security key from stdin must be non-empty");
  return value;
}

async function readPayload(args: Args): Promise<unknown> {
  if (args["payload-file"] && args["payload-json"]) {
    throw new Error("Use only one of --payload-file or --payload-json");
  }
  if (args["payload-file"]) {
    return JSON.parse(await readFile(String(args["payload-file"]), "utf8"));
  }
  if (args["payload-json"]) {
    return JSON.parse(String(args["payload-json"]));
  }
  return {
    event: "agent-webhook-test",
    message: "Test delivery from Letta Code",
    sent_at: new Date().toISOString(),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error("--limit must be an integer from 1 through 50");
  }
  return parsed;
}

function managementHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function requireWebhookId(args: Args): string {
  return requireString(args["webhook-id"], "Pass --webhook-id");
}

function requireConfirmation(args: Args, action: string): void {
  if (args.confirm !== true) {
    throw new Error(`${action} requires --confirm`);
  }
}

async function listWebhooks(params: {
  agentId: string;
  baseUrl: string;
  headers: Record<string, string>;
}): Promise<AgentWebhook[]> {
  return webhookList(
    await requestJson(
      `${params.baseUrl}/v1/agents/${params.agentId}/webhooks`,
      {
        headers: params.headers,
      },
    ),
  );
}

async function runManagementCommand(params: {
  agentId: string;
  args: Args;
  baseUrl: string;
  command: string;
  headers: Record<string, string>;
}): Promise<void> {
  const collectionUrl = `${params.baseUrl}/v1/agents/${params.agentId}/webhooks`;

  if (params.command === "list") {
    const webhooks = await listWebhooks(params);
    printJson({ webhooks: webhooks.map(safeAgentWebhook) });
    return;
  }

  if (params.command === "create") {
    const isPublic = params.args.public === true;
    const usesSecurityKey = params.args["security-key-stdin"] === true;
    if (isPublic === usesSecurityKey) {
      throw new Error("Choose exactly one of --public or --security-key-stdin");
    }
    const securityKey = await readSecurityKey(params.args);
    const body: JsonObject = {
      enabled: params.args.disabled !== true,
      name: requireString(params.args.name, "Create requires --name"),
      requires_authorization_header: usesSecurityKey,
    };
    if (params.args.preprompt) body.preprompt = String(params.args.preprompt);
    if (securityKey) body.security_key = securityKey;

    const response = jsonObject(
      await requestJson(collectionUrl, {
        body: JSON.stringify(body),
        headers: params.headers,
        method: "POST",
      }),
      "Create response must be an object",
    );
    printJson({
      webhook: safeAgentWebhook(webhookFromUnknown(response.webhook)),
    });
    return;
  }

  const webhookId = requireWebhookId(params.args);
  const itemUrl = `${collectionUrl}/${encodeURIComponent(webhookId)}`;

  if (params.command === "requests") {
    const limit = positiveInteger(params.args.limit, 10);
    const response = jsonObject(
      await requestJson(`${itemUrl}/requests?limit=${limit}`, {
        headers: params.headers,
      }),
      "Request history response must be an object",
    );
    if (!Array.isArray(response.requests)) {
      throw new Error("Request history response is missing requests");
    }
    const requests = response.requests.map((entry) => {
      const request = jsonObject(
        entry,
        "Request history item must be an object",
      );
      if (params.args["include-body"] === true) return request;
      const { request_body: _requestBody, ...safe } = request;
      return safe;
    });
    printJson({ requests });
    return;
  }

  if (params.command === "enable" || params.command === "disable") {
    if (params.command === "disable") {
      requireConfirmation(params.args, "Disabling a webhook");
    }
    const response = jsonObject(
      await requestJson(itemUrl, {
        body: JSON.stringify({ enabled: params.command === "enable" }),
        headers: params.headers,
        method: "PATCH",
      }),
      "Update response must be an object",
    );
    printJson({
      webhook: safeAgentWebhook(webhookFromUnknown(response.webhook)),
    });
    return;
  }

  if (params.command === "rotate") {
    requireConfirmation(params.args, "Rotating a webhook URL");
    const response = jsonObject(
      await requestJson(`${itemUrl}/refresh`, {
        body: "{}",
        headers: params.headers,
        method: "POST",
      }),
      "Rotate response must be an object",
    );
    printJson({
      webhook: safeAgentWebhook(webhookFromUnknown(response.webhook)),
    });
    return;
  }

  if (params.command === "delete") {
    requireConfirmation(params.args, "Deleting a webhook");
    printJson(
      await requestJson(itemUrl, {
        body: "{}",
        headers: params.headers,
        method: "DELETE",
      }),
    );
    return;
  }

  if (params.command === "test") {
    const webhooks = await listWebhooks(params);
    const webhook = webhooks.find((candidate) => candidate.id === webhookId);
    if (!webhook) throw new Error(`Webhook not found: ${webhookId}`);
    const securityKey = await readSecurityKey(params.args);
    if (webhook.requires_authorization_header && !securityKey) {
      throw new Error("This webhook requires --security-key-stdin");
    }
    if (!webhook.requires_authorization_header && securityKey) {
      throw new Error("This webhook is public; do not supply a security key");
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (securityKey) {
      headers.Authorization = buildAgentWebhookBasicAuthorization(securityKey);
    }
    const response = await fetch(webhook.webhook_url, {
      body: JSON.stringify(await readPayload(params.args)),
      headers,
      method: "POST",
    });
    const body = await parseResponse(response);
    if (!response.ok) {
      const rendered = typeof body === "string" ? body : JSON.stringify(body);
      throw new Error(
        `Webhook test failed with HTTP ${response.status}: ${rendered}`,
      );
    }
    printJson({
      accepted: response.status === 202,
      body,
      status_code: response.status,
    });
    return;
  }

  throw new Error(`Unsupported command: ${params.command}`);
}

export async function runAgentWebhookCli(argv: string[]): Promise<void> {
  const { args, command } = parseAgentWebhookArgs(argv);
  const agentId = resolveAgentWebhookTarget({
    currentAgentId: process.env.AGENT_ID,
    requestedAgentId: args["agent-id"] ? String(args["agent-id"]) : undefined,
  });
  const baseUrl = normalizedBaseUrl(
    args["base-url"] || process.env.LETTA_BASE_URL,
  );
  const apiKey = requireString(
    process.env.LETTA_API_KEY,
    "LETTA_API_KEY is required",
  );
  await runManagementCommand({
    agentId,
    args,
    baseUrl,
    command,
    headers: managementHeaders(apiKey),
  });
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  runAgentWebhookCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
