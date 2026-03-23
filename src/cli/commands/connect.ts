// src/cli/commands/connect.ts
// Command handlers for provider connection management in TUI slash commands

import {
  checkProviderApiKey,
  createOrUpdateProvider,
  getProviderByName,
  removeProviderByName,
} from "../../providers/byok-providers";
import {
  deleteOpenAICodexProvider,
  getOpenAICodexProvider,
  listProviders,
  OPENAI_CODEX_PROVIDER_NAME,
  removeOpenAICodexProvider,
} from "../../providers/openai-codex-provider";
import { getErrorMessage } from "../../utils/error";
import type { Buffers, Line } from "../helpers/accumulator";
import {
  isConnectApiKeyProvider,
  isConnectBedrockProvider,
  isConnectOAuthProvider,
  isConnectZaiBaseProvider,
  listConnectProvidersForHelp,
  listConnectProviderTokens,
  type ResolvedConnectProvider,
  resolveConnectProvider,
} from "./connect-normalize";
import {
  isChatGPTOAuthConnected,
  runChatGPTOAuthConnectFlow,
} from "./connect-oauth-core";

// tiny helper for unique ids
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type CommandLine = Extract<Line, { kind: "command" }>;

let activeCommandId: string | null = null;

export function setActiveCommandId(id: string | null): void {
  activeCommandId = id;
}

export interface ConnectCommandContext {
  buffersRef: { current: Buffers };
  refreshDerived: () => void;
  setCommandRunning: (running: boolean) => void;
  onCodexConnected?: () => void;
}

function addCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): string {
  const cmdId = activeCommandId ?? uid("cmd");
  const existing = buffersRef.current.byId.get(cmdId);
  const nextInput =
    existing && existing.kind === "command" ? existing.input : input;
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input: nextInput,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  if (!buffersRef.current.order.includes(cmdId)) {
    buffersRef.current.order.push(cmdId);
  }
  refreshDerived();
  return cmdId;
}

function updateCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  cmdId: string,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): void {
  const existing = buffersRef.current.byId.get(cmdId);
  const nextInput =
    existing && existing.kind === "command" ? existing.input : input;
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input: nextInput,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  refreshDerived();
}

function parseArgs(msg: string): string[] {
  return msg.trim().split(/\s+/).filter(Boolean);
}

function formatConnectUsage(): string {
  return [
    "Usage: /connect <provider> [options]",
    "",
    "Available providers:",
    `  • ${listConnectProvidersForHelp().join("\n  • ")}`,
    "",
    "Examples:",
    "  /connect chatgpt",
    "  /connect codex",
    "  /connect anthropic <api_key>",
    "  /connect openai <api_key>",
    "  /connect bedrock iam --access-key <id> --secret-key <key> --region <region>",
    "  /connect bedrock profile --profile <name> --region <region>",
  ].join("\n");
}

function formatUnknownProviderError(provider: string): string {
  return [
    `Error: Unknown provider "${provider}"`,
    "",
    `Available providers: ${listConnectProviderTokens().join(", ")}`,
    "Usage: /connect <provider> [options]",
  ].join("\n");
}

function parseBedrockFlags(args: string[]): {
  method: string | null;
  accessKey: string;
  secretKey: string;
  region: string;
  profile: string;
  error?: string;
} {
  let method: string | null = null;
  const values: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (!token.startsWith("--") && !method) {
      method = token.toLowerCase();
      continue;
    }

    if (!token.startsWith("--")) {
      return {
        method,
        accessKey: "",
        secretKey: "",
        region: "",
        profile: "",
        error: `Unexpected argument: ${token}`,
      };
    }

    const key = token.slice(2);
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      return {
        method,
        accessKey: "",
        secretKey: "",
        region: "",
        profile: "",
        error: `Missing value for --${key}`,
      };
    }
    values[key] = value;
    i += 1;
  }

  return {
    method,
    accessKey: values["access-key"] ?? "",
    secretKey: values["secret-key"] ?? values["api-key"] ?? "",
    region: values.region ?? "",
    profile: values.profile ?? "",
  };
}

function formatBedrockUsage(): string {
  return [
    "Usage: /connect bedrock <method> [options]",
    "",
    "Methods:",
    "  iam     --access-key <id> --secret-key <key> --region <region>",
    "  profile --profile <name> --region <region>",
    "",
    "Examples:",
    "  /connect bedrock iam --access-key AKIA... --secret-key ... --region us-east-1",
    "  /connect bedrock profile --profile default --region us-east-1",
  ].join("\n");
}

function formatApiKeyUsage(provider: ResolvedConnectProvider): string {
  return [
    `Usage: /connect ${provider.canonical} <api_key>`,
    "",
    `Connect to ${provider.byokProvider.displayName} by providing your API key.`,
  ].join("\n");
}

function formatZaiCodingPlanPrompt(apiKey?: string): string {
  const keyHint = apiKey ? ` ${apiKey}` : " <api_key>";
  return [
    "Connect to Z.ai",
    "",
    "Do you have a Z.ai Coding plan?",
    "",
    `  • Coding plan:  /connect zai-coding${keyHint}`,
    `  • Regular API:  /connect zai${keyHint}`,
  ].join("\n");
}

async function handleConnectChatGPT(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  const existingProvider = await isChatGPTOAuthConnected();
  if (existingProvider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Already connected to ChatGPT via OAuth.\n\nUse /disconnect chatgpt (or /disconnect codex) to remove the current connection first.",
      false,
    );
    return;
  }

  ctx.setCommandRunning(true);
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Checking account eligibility...",
    true,
    "running",
  );

  try {
    await runChatGPTOAuthConnectFlow({
      onStatus: (status) =>
        updateCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          cmdId,
          msg,
          status,
          true,
          "running",
        ),
    });

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Successfully connected to ChatGPT!\n\n` +
        `Provider '${OPENAI_CODEX_PROVIDER_NAME}' created/updated in Letta.\n` +
        "Your ChatGPT Plus/Pro subscription is now linked.",
      true,
      "finished",
    );

    if (ctx.onCodexConnected) {
      setTimeout(() => ctx.onCodexConnected?.(), 500);
    }
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✗ Failed to connect: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

async function handleConnectApiKeyProvider(
  ctx: ConnectCommandContext,
  msg: string,
  provider: ResolvedConnectProvider,
  apiKey: string,
): Promise<void> {
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Validating ${provider.byokProvider.displayName} API key...`,
    true,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    await checkProviderApiKey(provider.byokProvider.providerType, apiKey);

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Saving ${provider.byokProvider.displayName} provider...`,
      true,
      "running",
    );

    await createOrUpdateProvider(
      provider.byokProvider.providerType,
      provider.byokProvider.providerName,
      apiKey,
    );

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Successfully connected to ${provider.byokProvider.displayName}!\n\n` +
        `Provider '${provider.byokProvider.providerName}' created/updated in Letta.`,
      true,
      "finished",
    );
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✗ Failed to connect ${provider.byokProvider.displayName}: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

async function handleConnectBedrock(
  ctx: ConnectCommandContext,
  msg: string,
  provider: ResolvedConnectProvider,
  args: string[],
): Promise<void> {
  const parsed = parseBedrockFlags(args);
  if (parsed.error) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `${parsed.error}\n\n${formatBedrockUsage()}`,
      false,
    );
    return;
  }

  const method = (parsed.method ?? "").toLowerCase();
  if (!method || (method !== "iam" && method !== "profile")) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `Invalid bedrock method: ${parsed.method || "(missing)"}\n\n${formatBedrockUsage()}`,
      false,
    );
    return;
  }

  if (
    method === "iam" &&
    (!parsed.accessKey || !parsed.secretKey || !parsed.region)
  ) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `Missing required IAM fields.\n\n${formatBedrockUsage()}`,
      false,
    );
    return;
  }

  if (method === "profile" && (!parsed.profile || !parsed.region)) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `Missing required profile fields.\n\n${formatBedrockUsage()}`,
      false,
    );
    return;
  }

  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Validating AWS Bedrock credentials...",
    true,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    await checkProviderApiKey(
      provider.byokProvider.providerType,
      method === "iam" ? parsed.secretKey : "",
      method === "iam" ? parsed.accessKey : undefined,
      parsed.region,
      method === "profile" ? parsed.profile : undefined,
    );

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      "Saving AWS Bedrock provider...",
      true,
      "running",
    );

    await createOrUpdateProvider(
      provider.byokProvider.providerType,
      provider.byokProvider.providerName,
      method === "iam" ? parsed.secretKey : "",
      method === "iam" ? parsed.accessKey : undefined,
      parsed.region,
      method === "profile" ? parsed.profile : undefined,
    );

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Successfully connected to ${provider.byokProvider.displayName}!\n\n` +
        `Provider '${provider.byokProvider.providerName}' created/updated in Letta.`,
      true,
      "finished",
    );
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✗ Failed to connect AWS Bedrock: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

export async function handleConnect(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  const parts = parseArgs(msg);
  const providerToken = parts[1];

  if (!providerToken) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      formatConnectUsage(),
      false,
    );
    return;
  }

  const provider = resolveConnectProvider(providerToken);
  if (!provider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      formatUnknownProviderError(providerToken),
      false,
    );
    return;
  }

  if (isConnectOAuthProvider(provider)) {
    await handleConnectChatGPT(ctx, msg);
    return;
  }

  if (isConnectBedrockProvider(provider)) {
    await handleConnectBedrock(ctx, msg, provider, parts.slice(2));
    return;
  }

  if (isConnectApiKeyProvider(provider)) {
    const apiKey = parts.slice(2).join("");
    if (!apiKey) {
      if (isConnectZaiBaseProvider(provider)) {
        addCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          msg,
          formatZaiCodingPlanPrompt(),
          false,
        );
      } else {
        addCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          msg,
          formatApiKeyUsage(provider),
          false,
        );
      }
      return;
    }
    await handleConnectApiKeyProvider(ctx, msg, provider, apiKey);
  }
}

function formatDisconnectHelp(): string {
  return [
    "/disconnect help",
    "",
    "Disconnect an existing account.",
    "",
    "USAGE",
    "  /disconnect <provider>   — disconnect a provider",
    "  /disconnect help         — show this help",
    "",
    "PROVIDERS",
    `  ${listConnectProvidersForHelp().join(", ")}, claude (legacy)`,
  ].join("\n");
}

async function handleDisconnectChatGPT(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  const existingProvider = await getOpenAICodexProvider();
  if (!existingProvider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Not currently connected to ChatGPT via OAuth.\n\nUse /connect chatgpt (or /connect codex) to authenticate.",
      false,
    );
    return;
  }

  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Disconnecting from ChatGPT OAuth...",
    true,
    "running",
  );

  ctx.setCommandRunning(true);
  try {
    await removeOpenAICodexProvider();
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Disconnected from ChatGPT OAuth.\n\n` +
        `Provider '${OPENAI_CODEX_PROVIDER_NAME}' removed from Letta.`,
      true,
      "finished",
    );
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✗ Failed to disconnect from ChatGPT: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

async function handleDisconnectByokProvider(
  ctx: ConnectCommandContext,
  msg: string,
  provider: ResolvedConnectProvider,
): Promise<void> {
  const existing = await getProviderByName(provider.byokProvider.providerName);
  if (!existing) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `Not currently connected to ${provider.byokProvider.displayName}.\n\nUse /connect ${provider.canonical} to connect.`,
      false,
    );
    return;
  }

  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Disconnecting from ${provider.byokProvider.displayName}...`,
    true,
    "running",
  );

  ctx.setCommandRunning(true);
  try {
    await removeProviderByName(provider.byokProvider.providerName);
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Disconnected from ${provider.byokProvider.displayName}.\n\n` +
        `Provider '${provider.byokProvider.providerName}' removed from Letta.`,
      true,
      "finished",
    );
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✗ Failed to disconnect from ${provider.byokProvider.displayName}: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

async function handleDisconnectClaude(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  const CLAUDE_PROVIDER_NAME = "claude-pro-max";

  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Checking for Claude provider...",
    true,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    const providers = await listProviders();
    const claudeProvider = providers.find(
      (provider) => provider.name === CLAUDE_PROVIDER_NAME,
    );

    if (!claudeProvider) {
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `No Claude provider found.\n\nThe '${CLAUDE_PROVIDER_NAME}' provider does not exist in your Letta account.`,
        false,
        "finished",
      );
      return;
    }

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      "Removing Claude provider...",
      true,
      "running",
    );

    await deleteOpenAICodexProvider(claudeProvider.id);

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      "✓ Disconnected from Claude.\n\n" +
        `Provider '${CLAUDE_PROVIDER_NAME}' has been removed from Letta.\n\n` +
        "Note: /connect claude has been replaced by /connect chatgpt (alias: /connect codex).",
      true,
      "finished",
    );
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✗ Failed to disconnect from Claude: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

export async function handleDisconnect(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  const parts = parseArgs(msg);
  const providerToken = parts[1]?.toLowerCase();

  if (providerToken === "help") {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      formatDisconnectHelp(),
      true,
    );
    return;
  }

  if (!providerToken) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /disconnect <provider>",
      false,
    );
    return;
  }

  if (providerToken === "claude") {
    await handleDisconnectClaude(ctx, msg);
    return;
  }

  const provider = resolveConnectProvider(providerToken);
  if (!provider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `Unknown provider: "${providerToken}". Run /disconnect help for usage.`,
      false,
    );
    return;
  }

  if (isConnectOAuthProvider(provider)) {
    await handleDisconnectChatGPT(ctx, msg);
    return;
  }

  await handleDisconnectByokProvider(ctx, msg, provider);
}
