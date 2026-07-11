// src/cli/commands/connect.ts
// Command handlers for provider connection management in TUI slash commands

import {
  formatLocalProviderTimeout,
  type LocalProviderTimeout,
  parseLocalProviderTimeout,
} from "@/backend/local/local-provider-timeout";
import { setActiveConnectAbortController } from "@/cli/commands/connect-command-state";
import type { Buffers, Line } from "@/cli/helpers/accumulator";
import {
  checkProviderApiKey,
  createOrUpdateProvider,
  getProviderByName,
  type ProviderStorageTarget,
  providerStorageTargetLabel,
} from "@/providers/byok-providers";
import {
  createOrUpdateOpenAICodexProvider,
  getOpenAICodexProvider,
  normalizeChatGPTOAuthProviderName,
  OPENAI_CODEX_PROVIDER_NAME,
} from "@/providers/openai-codex-provider";
import { getErrorMessage } from "@/utils/error";
import { runLocalOAuthConnectFlow } from "./connect-local-oauth";
import {
  defaultConnectApiKey,
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
  target?: ProviderStorageTarget;
  onCodexConnected?: (providerName: string) => void;
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
    "  /connect chatgpt --name chatgpt-work",
    "  /connect codex",
    "  /connect anthropic <api_key>",
    "  /connect openai <api_key>",
    "  /connect lmstudio --base-url http://127.0.0.1:1234/v1 --timeout 600s",
    "  /connect bedrock iam --access-key <id> --secret-key <key> --region <region>",
    "  /connect bedrock profile --profile <name> --region <region>",
  ].join("\n");
}

function formatUnknownProviderError(
  provider: string,
  target?: ProviderStorageTarget,
): string {
  return [
    `Error: Unknown provider "${provider}"`,
    "",
    `Available providers: ${listConnectProviderTokens(target).join(", ")}`,
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
  if (defaultConnectApiKey(provider)) {
    return [
      `Usage: /connect ${provider.canonical} [api_key]`,
      "",
      `Connect to ${provider.byokProvider.displayName}. API key is optional for this local provider.`,
      "Optional: --base-url <url> --timeout <ms|duration|false>",
    ].join("\n");
  }
  return [
    `Usage: /connect ${provider.canonical} <api_key>`,
    "",
    `Connect to ${provider.byokProvider.displayName} by providing your API key.`,
    "Optional: --base-url <url> --timeout <ms|duration|false>",
  ].join("\n");
}

function readFlagValue(
  args: string[],
  index: number,
  flag: string,
): { value?: string; nextIndex: number; error?: string } {
  const token = args[index] ?? "";
  const equalsPrefix = `${flag}=`;
  if (token.startsWith(equalsPrefix)) {
    const value = token.slice(equalsPrefix.length);
    return value
      ? { value, nextIndex: index }
      : { nextIndex: index, error: `Missing value for ${flag}` };
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    return { nextIndex: index, error: `Missing value for ${flag}` };
  }
  return { value, nextIndex: index + 1 };
}

function parseApiProviderArgs(args: string[]): {
  apiKey?: string;
  baseURL?: string;
  timeout?: LocalProviderTimeout;
  error?: string;
} {
  const positionals: string[] = [];
  let apiKey: string | undefined;
  let baseURL: string | undefined;
  let timeout: LocalProviderTimeout | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token === "--no-timeout") {
      timeout = false;
      continue;
    }

    if (token === "--api-key" || token.startsWith("--api-key=")) {
      const parsed = readFlagValue(args, i, "--api-key");
      if (parsed.error) return { error: parsed.error };
      apiKey = parsed.value;
      i = parsed.nextIndex;
      continue;
    }

    if (token === "--base-url" || token.startsWith("--base-url=")) {
      const parsed = readFlagValue(args, i, "--base-url");
      if (parsed.error) return { error: parsed.error };
      baseURL = parsed.value;
      i = parsed.nextIndex;
      continue;
    }

    if (token === "--timeout" || token.startsWith("--timeout=")) {
      const parsed = readFlagValue(args, i, "--timeout");
      if (parsed.error) return { error: parsed.error };
      try {
        timeout = parseLocalProviderTimeout(parsed.value);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
      i = parsed.nextIndex;
      continue;
    }

    if (token.startsWith("--")) {
      return { error: `Unknown option: ${token}` };
    }

    positionals.push(token);
  }

  return {
    apiKey: apiKey ?? positionals.join(""),
    baseURL,
    timeout,
  };
}

function parseChatGPTArgs(args: string[]): {
  providerName: string;
  error?: string;
} {
  let providerName = OPENAI_CODEX_PROVIDER_NAME;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token === "--name" || token.startsWith("--name=")) {
      const parsed = readFlagValue(args, i, "--name");
      if (parsed.error) return { providerName, error: parsed.error };
      providerName = parsed.value ?? providerName;
      i = parsed.nextIndex;
      continue;
    }

    if (token.startsWith("--")) {
      return { providerName, error: `Unknown option: ${token}` };
    }

    return { providerName, error: `Unexpected argument: ${token}` };
  }

  try {
    return { providerName: normalizeChatGPTOAuthProviderName(providerName) };
  } catch (error) {
    return {
      providerName,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function providerOptionsSummary(options: {
  baseURL?: string;
  timeout?: LocalProviderTimeout;
}): string {
  const lines: string[] = [];
  if (options.baseURL) lines.push(`Base URL: ${options.baseURL}`);
  if (options.timeout !== undefined) {
    lines.push(`Timeout: ${formatLocalProviderTimeout(options.timeout)}`);
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}

function hasProviderOptions(options: {
  baseURL?: string;
  timeout?: LocalProviderTimeout;
}): boolean {
  return options.baseURL !== undefined || options.timeout !== undefined;
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
  providerName: string = OPENAI_CODEX_PROVIDER_NAME,
): Promise<void> {
  const existingProvider = await isChatGPTOAuthConnected({
    getProvider: () =>
      getOpenAICodexProvider({ target: ctx.target }, providerName),
  });
  if (existingProvider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `Already connected to ChatGPT via OAuth as '${providerName}'.\n\nOpen /connect and select ChatGPT / Codex plan in the current tab to disconnect or re-authenticate.`,
      false,
    );
    return;
  }

  ctx.setCommandRunning(true);
  const abortController = new AbortController();
  setActiveConnectAbortController(abortController);
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Checking account eligibility...",
    true,
    "running",
  );

  try {
    await runChatGPTOAuthConnectFlow(
      {
        signal: abortController.signal,
        providerName,
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
      },
      {
        getProvider: () =>
          getOpenAICodexProvider({ target: ctx.target }, providerName),
        createOrUpdateProvider: (config) =>
          createOrUpdateOpenAICodexProvider(
            config,
            { target: ctx.target },
            providerName,
          ),
      },
    );

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Successfully connected to ChatGPT!\n\n` +
        `Provider '${providerName}' saved in ${providerStorageTargetLabel(ctx.target)}.\n` +
        "Your ChatGPT Plus/Pro subscription is now linked.",
      true,
      "finished",
    );

    if (ctx.onCodexConnected) {
      setTimeout(() => ctx.onCodexConnected?.(providerName), 500);
    }
  } catch (error) {
    const isCancelled = error instanceof Error && error.name === "AbortError";
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      isCancelled
        ? "Cancelled ChatGPT connection."
        : `✗ Failed to connect: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    setActiveConnectAbortController(null);
    ctx.setCommandRunning(false);
  }
}

async function handleConnectLocalOAuthProvider(
  ctx: ConnectCommandContext,
  msg: string,
  provider: ResolvedConnectProvider,
): Promise<void> {
  const existingProvider = await getProviderByName(
    provider.byokProvider.providerName,
    { target: "local" },
  );
  if (existingProvider?.auth_type === "oauth") {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `Already connected to ${provider.byokProvider.displayName}.\n\nOpen /connect and select it in the Local tab to disconnect or re-authenticate.`,
      false,
    );
    return;
  }

  ctx.setCommandRunning(true);
  const abortController = new AbortController();
  setActiveConnectAbortController(abortController);
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Starting ${provider.byokProvider.displayName} login...`,
    true,
    "running",
  );

  try {
    await runLocalOAuthConnectFlow(provider.byokProvider, {
      signal: abortController.signal,
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
      `✓ Successfully connected to ${provider.byokProvider.displayName}!\n\n` +
        `Provider '${provider.byokProvider.providerName}' saved in local storage.`,
      true,
      "finished",
    );

    if (provider.byokProvider.oauthProviderId === "openai-codex") {
      setTimeout(
        () => ctx.onCodexConnected?.(provider.byokProvider.providerName),
        500,
      );
    }
  } catch (error) {
    const isCancelled = error instanceof Error && error.name === "AbortError";
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      isCancelled
        ? `Cancelled ${provider.byokProvider.displayName} connection.`
        : `✗ Failed to connect ${provider.byokProvider.displayName}: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    setActiveConnectAbortController(null);
    ctx.setCommandRunning(false);
  }
}

async function handleConnectApiKeyProvider(
  ctx: ConnectCommandContext,
  msg: string,
  provider: ResolvedConnectProvider,
  apiKey: string,
  options: { baseURL?: string; timeout?: LocalProviderTimeout } = {},
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
    await checkProviderApiKey(
      provider.byokProvider.providerType,
      apiKey,
      undefined,
      undefined,
      undefined,
      { target: ctx.target, connection: options },
    );

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Saving ${provider.byokProvider.displayName} provider...`,
      true,
      "running",
    );

    if (hasProviderOptions(options)) {
      await createOrUpdateProvider(
        provider.byokProvider.providerType,
        provider.byokProvider.providerName,
        apiKey,
        undefined,
        undefined,
        undefined,
        options,
        { target: ctx.target },
      );
    } else {
      await createOrUpdateProvider(
        provider.byokProvider.providerType,
        provider.byokProvider.providerName,
        apiKey,
        undefined,
        undefined,
        undefined,
        {},
        { target: ctx.target },
      );
    }

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Successfully connected to ${provider.byokProvider.displayName}!\n\n` +
        `Provider '${provider.byokProvider.providerName}' saved in ${providerStorageTargetLabel(ctx.target)}.` +
        providerOptionsSummary(options),
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
      { target: ctx.target },
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
      {},
      { target: ctx.target },
    );

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Successfully connected to ${provider.byokProvider.displayName}!\n\n` +
        `Provider '${provider.byokProvider.providerName}' saved in ${providerStorageTargetLabel(ctx.target)}.`,
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

  const provider = resolveConnectProvider(providerToken, ctx.target);
  if (!provider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      formatUnknownProviderError(providerToken, ctx.target),
      false,
    );
    return;
  }

  if (isConnectOAuthProvider(provider)) {
    if (provider.target === "local") {
      await handleConnectLocalOAuthProvider(ctx, msg, provider);
    } else {
      const parsed = parseChatGPTArgs(parts.slice(2));
      if (parsed.error) {
        addCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          msg,
          `${parsed.error}\n\nUsage: /connect chatgpt [--name <provider-name>]`,
          false,
        );
        return;
      }
      await handleConnectChatGPT(ctx, msg, parsed.providerName);
    }
    return;
  }

  if (isConnectBedrockProvider(provider)) {
    await handleConnectBedrock(ctx, msg, provider, parts.slice(2));
    return;
  }

  if (isConnectApiKeyProvider(provider)) {
    const parsed = parseApiProviderArgs(parts.slice(2));
    if (parsed.error) {
      addCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        msg,
        `${parsed.error}\n\n${formatApiKeyUsage(provider)}`,
        false,
      );
      return;
    }
    const apiKey = parsed.apiKey || defaultConnectApiKey(provider);
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
    await handleConnectApiKeyProvider(ctx, msg, provider, apiKey, {
      baseURL: parsed.baseURL,
      timeout: parsed.timeout,
    });
  }
}
