#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const BOOLEAN_FLAGS = new Set([
  "confirm",
  "disabled",
  "include-body",
  "public",
  "security-key-stdin",
  "secure",
]);
const COMMAND_OPTIONS = new Map([
  [
    "create",
    new Set([
      "credential-output",
      "disabled",
      "name",
      "preprompt",
      "public",
      "security-key-stdin",
      "secure",
    ]),
  ],
  ["delete", new Set(["confirm", "webhook-id"])],
  ["disable", new Set(["confirm", "webhook-id"])],
  ["enable", new Set(["webhook-id"])],
  ["list", new Set()],
  ["requests", new Set(["include-body", "limit", "webhook-id"])],
  ["rotate", new Set(["confirm", "webhook-id"])],
  [
    "test",
    new Set([
      "confirm",
      "credential-file",
      "payload-file",
      "security-key-stdin",
      "webhook-id",
    ]),
  ],
]);

function usage() {
  console.error(`Usage:
  node manage-agent-webhooks.mjs list
  node manage-agent-webhooks.mjs create --name <name> (--public | --secure --credential-output <path> | --security-key-stdin) [--preprompt <text>] [--disabled]
  node manage-agent-webhooks.mjs test --webhook-id <id> --confirm [--payload-file <path>] [--credential-file <path> | --security-key-stdin]
  node manage-agent-webhooks.mjs requests --webhook-id <id> [--limit <1-50>] [--include-body]
  node manage-agent-webhooks.mjs enable --webhook-id <id>
  node manage-agent-webhooks.mjs disable --webhook-id <id> --confirm
  node manage-agent-webhooks.mjs rotate --webhook-id <id> --confirm
  node manage-agent-webhooks.mjs delete --webhook-id <id> --confirm

Environment:
  LETTA_API_KEY   Required for management operations
  LETTA_BASE_URL  Active server supplied by the runtime
  AGENT_ID        Required current agent
`);
  process.exit(2);
}

export function parseAgentWebhookArgs(argv) {
  const [command = "", ...rest] = argv;
  if (!COMMANDS.has(command)) usage();
  const allowedOptions = COMMAND_OPTIONS.get(command);
  if (!allowedOptions) throw new Error(`Unsupported command: ${command}`);
  const args = {};
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
    if (!allowedOptions.has(key)) {
      throw new Error(`Unsupported option --${key} for ${command}`);
    }
    if (Object.hasOwn(args, key)) {
      throw new Error(`Duplicate option --${key}`);
    }
    if (BOOLEAN_FLAGS.has(key)) {
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

function requireString(value, message) {
  const stringValue = String(value ?? "").trim();
  if (!stringValue) throw new Error(message);
  return stringValue;
}

export function resolveAgentWebhookTarget(currentAgentId) {
  return requireString(
    currentAgentId,
    "AGENT_ID is required; this helper only manages the current agent",
  );
}

export function safeAgentWebhook(webhook) {
  const {
    authorization_header: _authorizationHeader,
    webhook_slug: _webhookSlug,
    ...safe
  } = webhook;
  return safe;
}

export function buildAgentWebhookBasicAuthorization(securityKey) {
  if (!securityKey) throw new Error("Security key must be non-empty");
  return `Basic ${Buffer.from(`webhook:${securityKey}`, "utf8").toString("base64")}`;
}

function normalizedBaseUrl(value) {
  const baseUrl = requireString(
    value,
    "LETTA_BASE_URL is required from the active runtime",
  );
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Base URL must use http or https");
  }
  const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (parsed.protocol === "http:" && !loopbackHostnames.has(parsed.hostname)) {
    throw new Error("Plaintext LETTA_BASE_URL is allowed only on loopback");
  }
  return parsed.toString().replace(/\/$/, "");
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const SAFE_ERROR_FIELDS = new Set([
  "code",
  "error",
  "errorCode",
  "error_code",
  "message",
  "requestId",
  "request_id",
]);
const SENSITIVE_FIELD_PATTERN =
  /authorization|credential|password|secret|security[_-]?key|token/i;

function redactString(value, sensitiveValues) {
  let redacted = value;
  const uniqueValues = [...new Set(sensitiveValues)]
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of uniqueValues) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function redactSensitiveValue(value, sensitiveValues) {
  if (typeof value === "string") {
    return redactString(value, sensitiveValues);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry, sensitiveValues));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_FIELD_PATTERN.test(key)
          ? "[REDACTED]"
          : redactSensitiveValue(entry, sensitiveValues),
      ]),
    );
  }
  return value;
}

function safeResponseDetails(body, sensitiveValues = []) {
  const redacted = redactSensitiveValue(body, sensitiveValues);
  if (typeof redacted === "string") {
    const normalized = redacted.trim();
    return normalized ? normalized.slice(0, 500) : "[response details omitted]";
  }
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    const allowed = Object.fromEntries(
      Object.entries(redacted).filter(([key]) => SAFE_ERROR_FIELDS.has(key)),
    );
    if (Object.keys(allowed).length > 0) {
      return JSON.stringify(allowed).slice(0, 500);
    }
  }
  return "[response details omitted]";
}

function safeErrorMessage(error, sensitiveValues = []) {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message, sensitiveValues);
}

function safeErrorCause(error, sensitiveValues = []) {
  const message = safeErrorMessage(error, sensitiveValues);
  return error instanceof Error && error.message === message
    ? error
    : new Error(message);
}

function authorizationSensitiveValues(authorizationHeader, securityKey) {
  return [
    authorizationHeader,
    authorizationHeader?.includes(" ")
      ? authorizationHeader.slice(authorizationHeader.indexOf(" ") + 1)
      : undefined,
    securityKey,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function httpError(response, body, sensitiveValues = [], prefix = "HTTP") {
  const statusText = redactString(response.statusText, sensitiveValues);
  return new Error(
    `${prefix} ${response.status} ${statusText}: ${safeResponseDetails(
      body,
      sensitiveValues,
    )}`,
  );
}

async function requestJson(url, init, options = {}) {
  const managementAuthorization =
    init?.headers?.Authorization ?? init?.headers?.authorization;
  const sensitiveValues = [
    ...(options.sensitiveValues ?? []),
    ...authorizationSensitiveValues(managementAuthorization),
  ];
  const response = await fetch(url, init);
  const body = await parseResponse(response);
  if (!response.ok) {
    throw httpError(response, body, sensitiveValues);
  }
  return body;
}

function jsonObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function webhookFromUnknown(value) {
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

function webhookList(value) {
  const body = jsonObject(value, "Webhook list response must be an object");
  if (!Array.isArray(body.webhooks)) {
    throw new Error("Webhook list response is missing webhooks");
  }
  return body.webhooks.map(webhookFromUnknown);
}

async function readSecurityKey(args) {
  if (args["security-key-stdin"] !== true) return undefined;
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  value = value.replace(/[\r\n]+$/, "");
  if (!value.trim()) {
    throw new Error(
      "Security key from stdin must contain a non-whitespace character",
    );
  }
  return value;
}

export async function reserveCredentialFile(outputPath, operations = {}) {
  const path = resolve(
    requireString(
      outputPath,
      "Generated credentials require --credential-output <path>",
    ),
  );
  const openFile = operations.openFile ?? open;
  const generateRandomBytes = operations.randomBytes ?? randomBytes;
  const unlinkFile = operations.unlinkFile ?? unlink;
  const handle = await openFile(path, "wx", 0o600);
  const reservation = { handle, path };
  let sensitiveValues = [];
  try {
    const securityKey = generateRandomBytes(24).toString("base64url");
    const authorizationHeader =
      buildAgentWebhookBasicAuthorization(securityKey);
    sensitiveValues = authorizationSensitiveValues(
      authorizationHeader,
      securityKey,
    );
    const contents = `${JSON.stringify(
      {
        authorization_header: authorizationHeader,
        security_key: securityKey,
      },
      null,
      2,
    )}\n`;
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    return { ...reservation, authorizationHeader, securityKey };
  } catch (error) {
    throw await cleanupCredentialFile(reservation, error, {
      sensitiveValues,
      unlinkFile,
    });
  }
}

export async function cleanupCredentialFile(
  reservation,
  originalError,
  operations = {},
) {
  const unlinkFile = operations.unlinkFile ?? unlink;
  const sensitiveValues = operations.sensitiveValues ?? [];
  const cleanupFailures = [];
  try {
    await reservation.handle.close();
  } catch (error) {
    cleanupFailures.push(`close: ${safeErrorMessage(error)}`);
  }
  try {
    await unlinkFile(reservation.path);
  } catch (error) {
    cleanupFailures.push(`unlink: ${safeErrorMessage(error)}`);
  }
  const originalMessage = safeErrorMessage(originalError, sensitiveValues);
  const safeCause = safeErrorCause(originalError, sensitiveValues);
  if (cleanupFailures.length === 0) {
    return originalError instanceof Error &&
      originalError.message === originalMessage
      ? originalError
      : new Error(originalMessage, { cause: safeCause });
  }
  return new Error(
    `${originalMessage} Credential cleanup did not complete; a sensitive file may remain at ${reservation.path}. Remove it manually. Cleanup errors: ${cleanupFailures.join("; ")}`,
    { cause: safeCause },
  );
}

async function finishCredentialFile(reservation) {
  await reservation.handle.close();
  return reservation.path;
}

export async function preserveCredentialFile(
  reservation,
  originalError,
  sensitiveValues,
) {
  let closeFailure;
  try {
    await reservation.handle.close();
  } catch (error) {
    closeFailure = safeErrorMessage(error);
  }
  const suffix = closeFailure
    ? ` The file handle did not close cleanly (${closeFailure}); the process will release it on exit.`
    : "";
  return new Error(
    `${safeErrorMessage(originalError, sensitiveValues)} Webhook creation status is unknown or may have succeeded. The credential was retained at ${reservation.path}.${suffix} Run list and reconcile the webhook name before retrying; do not create a duplicate.`,
    { cause: safeErrorCause(originalError, sensitiveValues) },
  );
}

async function readCredentialAuthorizationHeader(pathValue) {
  const path = resolve(
    requireString(pathValue, "Pass --credential-file <path>"),
  );
  const credential = jsonObject(
    JSON.parse(await readFile(path, "utf8")),
    "Credential file must contain a JSON object",
  );
  const authorizationHeader = requireString(
    credential.authorization_header,
    "Credential file is missing authorization_header",
  );
  const securityKey =
    credential.security_key === undefined
      ? undefined
      : requireString(
          credential.security_key,
          "Credential file security_key must be non-empty",
        );
  if (
    securityKey &&
    authorizationHeader !== buildAgentWebhookBasicAuthorization(securityKey)
  ) {
    throw new Error(
      "Credential file authorization_header does not match security_key",
    );
  }
  return {
    authorizationHeader,
    sensitiveValues: authorizationSensitiveValues(
      authorizationHeader,
      securityKey,
    ),
  };
}

async function readPayload(args) {
  if (args["payload-file"]) {
    return JSON.parse(await readFile(String(args["payload-file"]), "utf8"));
  }
  return {
    event: "agent-webhook-test",
    message: "Test delivery from Letta Code",
    sent_at: new Date().toISOString(),
  };
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error("--limit must be an integer from 1 through 50");
  }
  return parsed;
}

const DEFINITIVE_CREATE_REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 405, 413, 415, 422,
]);

function unknownCreationError(originalError, sensitiveValues) {
  return new Error(
    `${safeErrorMessage(originalError, sensitiveValues)} Webhook creation status is unknown or may have succeeded. Run list and reconcile the webhook name before retrying; do not create a duplicate.`,
    { cause: safeErrorCause(originalError, sensitiveValues) },
  );
}

function managementHeaders(apiKey) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function requireWebhookId(args) {
  return requireString(args["webhook-id"], "Pass --webhook-id");
}

function requireConfirmation(args, action) {
  if (args.confirm !== true) {
    throw new Error(`${action} requires --confirm`);
  }
}

async function listWebhooks(params) {
  const encodedAgentId = encodeURIComponent(params.agentId);
  return webhookList(
    await requestJson(
      `${params.baseUrl}/v1/agents/${encodedAgentId}/webhooks`,
      {
        headers: params.headers,
      },
    ),
  );
}

async function runManagementCommand(params) {
  const encodedAgentId = encodeURIComponent(params.agentId);
  const collectionUrl = `${params.baseUrl}/v1/agents/${encodedAgentId}/webhooks`;

  if (params.command === "list") {
    const webhooks = await listWebhooks(params);
    printJson({ webhooks: webhooks.map(safeAgentWebhook) });
    return;
  }

  if (params.command === "create") {
    const isPublic = params.args.public === true;
    const usesGeneratedCredential = params.args.secure === true;
    const usesSecurityKey = params.args["security-key-stdin"] === true;
    const modeCount = [
      isPublic,
      usesGeneratedCredential,
      usesSecurityKey,
    ].filter(Boolean).length;
    if (modeCount !== 1) {
      throw new Error(
        "Choose exactly one of --public, --secure, or --security-key-stdin",
      );
    }
    if (!usesGeneratedCredential && params.args["credential-output"]) {
      throw new Error("--credential-output is valid only with --secure");
    }
    const securityKey = await readSecurityKey(params.args);
    const body = {
      enabled: params.args.disabled !== true,
      name: requireString(params.args.name, "Create requires --name"),
      requires_authorization_header: usesGeneratedCredential || usesSecurityKey,
    };
    if (params.args.preprompt !== undefined) {
      body.preprompt = requireString(
        params.args.preprompt,
        "--preprompt must contain a non-whitespace character",
      );
    }
    if (securityKey) body.security_key = securityKey;
    const credentialReservation = usesGeneratedCredential
      ? await reserveCredentialFile(params.args["credential-output"])
      : undefined;
    if (credentialReservation) {
      body.security_key = credentialReservation.securityKey;
    }

    const sensitiveValues = [
      ...authorizationSensitiveValues(params.headers.Authorization),
      ...(credentialReservation
        ? authorizationSensitiveValues(
            credentialReservation.authorizationHeader,
            credentialReservation.securityKey,
          )
        : securityKey
          ? authorizationSensitiveValues(
              buildAgentWebhookBasicAuthorization(securityKey),
              securityKey,
            )
          : []),
    ];
    let creationState = "before-dispatch";
    try {
      creationState = "dispatched";
      const rawResponse = await fetch(collectionUrl, {
        body: JSON.stringify(body),
        headers: params.headers,
        method: "POST",
      });
      if (rawResponse.ok) {
        creationState = "accepted";
      } else if (DEFINITIVE_CREATE_REJECTION_STATUSES.has(rawResponse.status)) {
        creationState = "definitive-rejection";
      }
      const responseBody = await parseResponse(rawResponse);
      if (!rawResponse.ok) {
        throw httpError(rawResponse, responseBody, sensitiveValues);
      }
      const response = jsonObject(
        responseBody,
        "Create response must be an object",
      );
      const webhook = webhookFromUnknown(response.webhook);
      if (
        credentialReservation &&
        webhook.authorization_header !==
          credentialReservation.authorizationHeader
      ) {
        throw new Error(
          "Create response authorization_header does not match the generated credential",
        );
      }
      const credentialFile = credentialReservation
        ? await finishCredentialFile(credentialReservation)
        : undefined;
      printJson({
        ...(credentialFile
          ? {
              credential_file: credentialFile,
              credential_file_is_sensitive: true,
              credential_is_recoverable_from_server: false,
            }
          : {}),
        webhook: safeAgentWebhook(webhook),
      });
    } catch (error) {
      if (credentialReservation) {
        if (
          creationState === "before-dispatch" ||
          creationState === "definitive-rejection"
        ) {
          throw await cleanupCredentialFile(credentialReservation, error, {
            sensitiveValues,
          });
        }
        throw await preserveCredentialFile(
          credentialReservation,
          error,
          sensitiveValues,
        );
      }
      if (creationState === "dispatched" || creationState === "accepted") {
        throw unknownCreationError(error, sensitiveValues);
      }
      throw new Error(safeErrorMessage(error, sensitiveValues), {
        cause: safeErrorCause(error, sensitiveValues),
      });
    }
    return;
  }

  const webhookId = requireWebhookId(params.args);
  const itemUrl = `${collectionUrl}/${encodeURIComponent(webhookId)}`;

  if (params.command === "test") {
    requireConfirmation(params.args, "Testing a webhook");
  }

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
      const {
        enqueued: _enqueued,
        request_body: requestBody,
        ...acceptedRequest
      } = request;
      return {
        ...acceptedRequest,
        accepted: request.status_code === 202,
        ...(params.args["include-body"] === true
          ? { request_body: requestBody }
          : {}),
      };
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
    const usesCredentialFile = params.args["credential-file"] !== undefined;
    const usesSecurityKey = params.args["security-key-stdin"] === true;
    if (usesCredentialFile && usesSecurityKey) {
      throw new Error(
        "Choose at most one of --credential-file or --security-key-stdin",
      );
    }
    const securityKey = await readSecurityKey(params.args);
    const credential = usesCredentialFile
      ? await readCredentialAuthorizationHeader(params.args["credential-file"])
      : undefined;
    const authorizationHeader = credential
      ? credential.authorizationHeader
      : securityKey
        ? buildAgentWebhookBasicAuthorization(securityKey)
        : undefined;
    const sensitiveValues = credential
      ? credential.sensitiveValues
      : authorizationHeader
        ? authorizationSensitiveValues(authorizationHeader, securityKey)
        : [];
    if (webhook.requires_authorization_header && !authorizationHeader) {
      throw new Error(
        "This webhook requires --credential-file or --security-key-stdin",
      );
    }
    if (!webhook.requires_authorization_header && authorizationHeader) {
      throw new Error("This webhook is public; do not supply credentials");
    }

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (authorizationHeader) {
      headers.Authorization = authorizationHeader;
    }
    const response = await fetch(webhook.webhook_url, {
      body: JSON.stringify(await readPayload(params.args)),
      headers,
      method: "POST",
    });
    const body = await parseResponse(response);
    if (!response.ok) {
      throw httpError(
        response,
        body,
        sensitiveValues,
        "Webhook test failed with HTTP",
      );
    }
    printJson({
      accepted_for_processing: response.status === 202,
      body: redactSensitiveValue(body, sensitiveValues),
      dispatch_verified: false,
      note: "HTTP 202 confirms only that the ingress handler accepted the request; conversation creation and queue submission happen asynchronously.",
      status_code: response.status,
    });
    return;
  }

  throw new Error(`Unsupported command: ${params.command}`);
}

export async function runAgentWebhookCli(argv) {
  const { args, command } = parseAgentWebhookArgs(argv);
  const agentId = resolveAgentWebhookTarget(process.env.AGENT_ID);
  const baseUrl = normalizedBaseUrl(process.env.LETTA_BASE_URL);
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
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(resolve(process.argv[1]));

if (isMain) {
  runAgentWebhookCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
