import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { parseLocalProviderTimeout } from "@/backend/local/local-provider-timeout";
import {
  type LocalOAuthConnectCallbacks,
  runCloudOAuthConnectFlow,
  runLocalOAuthConnectFlow,
} from "@/cli/commands/connect-local-oauth";
import {
  defaultConnectApiKey,
  isConnectApiKeyProvider,
  isConnectBaseURLRequired,
  isConnectBedrockProvider,
  isConnectOAuthProvider,
  isConnectZaiBaseProvider,
  listConnectProvidersForHelp,
  listConnectProviderTokens,
  resolveConnectProvider,
} from "@/cli/commands/connect-normalize";
import {
  type ChatGPTOAuthFlowCallbacks,
  isChatGPTOAuthConnected,
  runChatGPTOAuthConnectFlow,
} from "@/cli/commands/connect-oauth-core";
import { runCloudXaiOAuthConnectFlow } from "@/cli/commands/connect-xai-oauth";
import {
  checkProviderApiKey,
  createOrUpdateProvider,
  defaultProviderStorageTarget,
  getProviderByNameStrict,
  isXaiOAuthProvider,
  type ProviderConnectionOptions,
  type ProviderOperationOptions,
  type ProviderResponse,
  type ProviderStorageTarget,
  providerStorageTargetLabel,
} from "@/providers/byok-providers";
import {
  getOpenAICodexProvider,
  normalizeChatGPTOAuthProviderName,
  OPENAI_CODEX_PROVIDER_NAME,
} from "@/providers/openai-codex-provider";
import { settingsManager } from "@/settings-manager";
import { getErrorMessage } from "@/utils/error";

const CONNECT_OPTIONS = {
  help: { type: "boolean", short: "h" },
  "api-key": { type: "string" },
  method: { type: "string" },
  "access-key": { type: "string" },
  "secret-key": { type: "string" },
  region: { type: "string" },
  profile: { type: "string" },
  "base-url": { type: "string" },
  name: { type: "string" },
  timeout: { type: "string" },
  "no-timeout": { type: "boolean" },
  force: { type: "boolean" },
} as const;

// Provider names become model-handle prefixes (e.g. `my-endpoint/model`), so
// restrict them to the same shape used for ChatGPT OAuth provider names.
const CONNECT_PROVIDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

interface ConnectSubcommandDeps {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  isTTY: () => boolean;
  ensureSettingsReady: () => Promise<void>;
  promptSecret: (label: string) => Promise<string>;
  checkProviderApiKey: (
    providerType: string,
    apiKey: string,
    accessKey?: string,
    region?: string,
    profile?: string,
    operationOptions?: ProviderOperationOptions,
  ) => Promise<void>;
  createOrUpdateProvider: (
    providerType: string,
    providerName: string,
    apiKey: string,
    accessKey?: string,
    region?: string,
    profile?: string,
    options?: ProviderConnectionOptions,
  ) => Promise<unknown>;
  getProviderByNameStrict: (
    providerName: string,
    options?: ProviderOperationOptions,
  ) => Promise<ProviderResponse | null>;
  confirmOverwrite: (message: string) => Promise<boolean>;
  isChatGPTOAuthConnected: (providerName?: string) => Promise<boolean>;
  runChatGPTOAuthConnectFlow: (
    callbacks: ChatGPTOAuthFlowCallbacks,
  ) => Promise<unknown>;
  runCloudOAuthConnectFlow: typeof runCloudOAuthConnectFlow;
  runCloudXaiOAuthConnectFlow: typeof runCloudXaiOAuthConnectFlow;
  runLocalOAuthConnectFlow: (
    provider: Parameters<typeof runLocalOAuthConnectFlow>[0],
    callbacks: LocalOAuthConnectCallbacks,
  ) => Promise<unknown>;
  providerStorageTargetLabel: () => string;
}

function readStringOption(
  value: string | boolean | (string | boolean)[] | undefined,
): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

const DEFAULT_DEPS: ConnectSubcommandDeps = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
  isTTY: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ensureSettingsReady: () => settingsManager.initialize(),
  promptSecret: promptSecret,
  checkProviderApiKey,
  createOrUpdateProvider,
  getProviderByNameStrict,
  confirmOverwrite,
  isChatGPTOAuthConnected: (providerName) =>
    isChatGPTOAuthConnected({
      getProvider: () =>
        getOpenAICodexProvider({}, providerName ?? OPENAI_CODEX_PROVIDER_NAME),
    }),
  runChatGPTOAuthConnectFlow,
  runCloudOAuthConnectFlow,
  runCloudXaiOAuthConnectFlow,
  runLocalOAuthConnectFlow,
  providerStorageTargetLabel,
};

function formatUsage(
  target: ProviderStorageTarget = defaultProviderStorageTarget(),
): string {
  const isLocal = target === "local";
  return [
    "Usage:",
    "  letta connect <provider> [options]",
    "",
    "Providers:",
    `  ${listConnectProvidersForHelp(target).join("\n  ")}`,
    "",
    "Examples:",
    "  letta connect chatgpt",
    ...(isLocal ? [] : ["  letta connect chatgpt --name chatgpt-work"]),
    "  letta connect grok",
    "  letta connect codex",
    "  letta connect codex --method device-code",
    "  letta connect anthropic <api_key>",
    "  letta connect openai --api-key <api_key>",
    "  letta connect openai-compatible --base-url http://localhost:8000/v1 [--api-key <api_key>]",
    ...(isLocal
      ? []
      : [
          "  letta connect openai-compatible --name my-endpoint --base-url http://localhost:8000/v1",
        ]),
    "  letta connect ollama --base-url http://192.168.1.50:11434/v1",
    "  letta connect lmstudio --base-url http://127.0.0.1:1234/v1 --timeout 600s",
    "  letta connect llama-cpp --base-url http://localhost:8080/v1",
    "  letta connect bedrock --method iam --access-key <id> --secret-key <key> --region <region>",
    "  letta connect bedrock --method profile --profile <name> --region <region>",
  ].join("\n");
}

function connectionOptionsFromArgs(
  values: ReturnType<typeof parseArgs>["values"],
): ProviderConnectionOptions {
  const baseURL = readStringOption(values["base-url"]);
  const timeoutValue = readStringOption(values.timeout);
  const noTimeout = values["no-timeout"] === true;
  return {
    ...(baseURL ? { baseURL } : {}),
    ...(noTimeout
      ? { timeout: false as const }
      : timeoutValue !== undefined
        ? { timeout: parseLocalProviderTimeout(timeoutValue) }
        : {}),
  };
}

function hasConnectionOptions(options: ProviderConnectionOptions): boolean {
  return options.baseURL !== undefined || options.timeout !== undefined;
}

interface ProviderSlotSnapshot {
  name: string;
  provider_type?: string | null;
  base_url?: string | null;
}

function formatProviderSlot(provider: ProviderSlotSnapshot): string {
  const providerType = provider.provider_type?.trim() || "unknown type";
  const baseURL = provider.base_url?.trim() || "provider default";
  return `${provider.name} (${providerType}, base URL: ${baseURL})`;
}

/**
 * Whether saving a new connection into an occupied provider slot changes what
 * that slot points at. Re-saving the same slot with a new credential for the
 * same provider type and endpoint is a key rotation, not an overwrite.
 */
function overwriteChangesSlot(
  existing: ProviderSlotSnapshot,
  providerType: string,
  baseURL: string | undefined,
): boolean {
  if ((existing.provider_type ?? "") !== providerType) return true;
  const existingBaseURL = existing.base_url?.trim() || undefined;
  const effectiveBaseURL = baseURL?.trim() || existingBaseURL;
  return effectiveBaseURL !== existingBaseURL;
}

async function confirmOverwrite(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(message)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function normalizeOAuthLoginMethod(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function formatBedrockUsage(): string {
  return [
    "Usage: letta connect bedrock [--method iam|profile] [options]",
    "",
    "IAM method:",
    "  --method iam --access-key <id> --secret-key <key> --region <region>",
    "",
    "Profile method:",
    "  --method profile --profile <name> --region <region>",
  ].join("\n");
}

async function promptSecret(promptLabel: string): Promise<string> {
  class MutedWritable extends Writable {
    muted = false;

    override _write(
      chunk: Buffer | string,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      if (!this.muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    }
  }

  const mutedOutput = new MutedWritable();
  const rl = createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true,
  });

  try {
    process.stdout.write(promptLabel);
    mutedOutput.muted = true;
    const answer = await rl.question("");
    process.stdout.write("\n");
    return answer.trim();
  } finally {
    mutedOutput.muted = false;
    rl.close();
  }
}

export async function runConnectSubcommand(
  argv: string[],
  deps: Partial<ConnectSubcommandDeps> = {},
): Promise<number> {
  const io = { ...DEFAULT_DEPS, ...deps };

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: CONNECT_OPTIONS,
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stdout(formatUsage());
    return 1;
  }

  const [providerToken, ...restPositionals] = parsed.positionals;

  if (parsed.values.help || !providerToken || providerToken === "help") {
    const target =
      (providerToken &&
        providerToken !== "help" &&
        (resolveConnectProvider(providerToken)?.target ??
          resolveConnectProvider(providerToken, "local")?.target)) ||
      defaultProviderStorageTarget();
    io.stdout(formatUsage(target));
    return 0;
  }

  const provider = resolveConnectProvider(providerToken);
  if (!provider) {
    const localProvider = resolveConnectProvider(providerToken, "local");
    if (localProvider) {
      io.stderr(
        `Provider "${providerToken}" is only available with the local backend.\n` +
          `Retry with: letta --backend local connect ${argv.join(" ")}`,
      );
      return 1;
    }
    io.stderr(
      `Unknown provider: ${providerToken}. Supported providers: ${listConnectProviderTokens().join(", ")}`,
    );
    return 1;
  }

  if (isConnectOAuthProvider(provider)) {
    try {
      if (provider.target !== "local") {
        await io.ensureSettingsReady();
        if (isXaiOAuthProvider(provider.byokProvider)) {
          const result = await io.runCloudXaiOAuthConnectFlow(
            provider.byokProvider,
            { onStatus: (status) => io.stdout(status) },
          );
          const providerName =
            typeof result === "object" &&
            result !== null &&
            "providerName" in result &&
            typeof result.providerName === "string"
              ? result.providerName
              : provider.byokProvider.providerName;
          io.stdout(
            `Successfully connected to ${provider.byokProvider.displayName}.\nProvider '${providerName}' saved.`,
          );
          return 0;
        }
        if (
          provider.byokProvider.oauthProviderId !== "openai-codex" &&
          provider.byokProvider.providerType !== "chatgpt_oauth"
        ) {
          const result = await io.runCloudOAuthConnectFlow(
            provider.byokProvider,
            { onStatus: (status) => io.stdout(status) },
          );
          const providerName =
            typeof result === "object" &&
            result !== null &&
            "providerName" in result &&
            typeof result.providerName === "string"
              ? result.providerName
              : provider.byokProvider.providerName;
          io.stdout(
            `Successfully connected to ${provider.byokProvider.displayName}.\nProvider '${providerName}' saved.`,
          );
          return 0;
        }

        let providerName: string;
        try {
          providerName = normalizeChatGPTOAuthProviderName(
            readStringOption(parsed.values.name),
          );
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }

        if (await io.isChatGPTOAuthConnected(providerName)) {
          io.stdout(
            `Already connected to ChatGPT via OAuth as '${providerName}'. Use /connect in the TUI and select ChatGPT / Codex plan to disconnect or re-authenticate.`,
          );
          return 0;
        }

        await io.runChatGPTOAuthConnectFlow({
          providerName,
          onStatus: (status) => io.stdout(status),
        });

        io.stdout(
          `Successfully connected to ChatGPT OAuth.\nProvider '${providerName}' saved.`,
        );
        return 0;
      }

      const loginMethod = readStringOption(parsed.values.method);
      let connectionOptions: ProviderConnectionOptions;
      try {
        connectionOptions = connectionOptionsFromArgs(parsed.values);
      } catch (error) {
        io.stderr(getErrorMessage(error));
        return 1;
      }
      await io.runLocalOAuthConnectFlow(provider.byokProvider, {
        baseURL: connectionOptions.baseURL,
        timeout: connectionOptions.timeout,
        onStatus: (status) => io.stdout(status),
        onPrompt: async (prompt) => {
          if (prompt.allowEmpty && !io.isTTY()) return "";
          if (!io.isTTY()) {
            throw new Error(
              `${provider.byokProvider.displayName} requires input: ${prompt.message}`,
            );
          }
          return io.promptSecret(
            `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `,
          );
        },
        onSelect: async (prompt) => {
          if (loginMethod) {
            const normalized = normalizeOAuthLoginMethod(loginMethod);
            const match = prompt.options.find(
              (option) => normalizeOAuthLoginMethod(option.id) === normalized,
            );
            if (!match) {
              throw new Error(
                `Unknown ${provider.byokProvider.displayName} login method: ${loginMethod}. Available: ${prompt.options.map((option) => option.id).join(", ")}`,
              );
            }
            return match.id;
          }
          // Default to the provider's first (default) option, e.g. browser login.
          return prompt.options[0]?.id;
        },
      });

      io.stdout(
        `Successfully connected to ${provider.byokProvider.displayName}.`,
      );
      return 0;
    } catch (error) {
      io.stderr(
        `Failed to connect ${provider.byokProvider.displayName}: ${getErrorMessage(error)}`,
      );
      return 1;
    }
  }

  if (isConnectBedrockProvider(provider)) {
    const method = (
      readStringOption(parsed.values.method) ??
      restPositionals[0] ??
      ""
    ).toLowerCase();
    const accessKey = readStringOption(parsed.values["access-key"]) ?? "";
    const secretKey = readStringOption(parsed.values["secret-key"]) ?? "";
    const region = readStringOption(parsed.values.region) ?? "";
    const profile = readStringOption(parsed.values.profile) ?? "";
    let connectionOptions: ProviderConnectionOptions;
    try {
      connectionOptions = connectionOptionsFromArgs(parsed.values);
    } catch (error) {
      io.stderr(getErrorMessage(error));
      return 1;
    }

    if (!method || (method !== "iam" && method !== "profile")) {
      io.stderr("Bedrock method must be `iam` or `profile`.");
      io.stdout(formatBedrockUsage());
      return 1;
    }

    if (method === "iam" && (!accessKey || !secretKey || !region)) {
      io.stderr(
        "Missing IAM fields. Required: --access-key, --secret-key, --region.",
      );
      io.stdout(formatBedrockUsage());
      return 1;
    }

    if (method === "profile" && (!profile || !region)) {
      io.stderr("Missing profile fields. Required: --profile and --region.");
      io.stdout(formatBedrockUsage());
      return 1;
    }

    try {
      io.stdout("Validating AWS Bedrock credentials...");
      if (provider.target !== "local") {
        await io.ensureSettingsReady();
      }
      await io.checkProviderApiKey(
        provider.byokProvider.providerType,
        method === "iam" ? secretKey : "",
        method === "iam" ? accessKey : undefined,
        region,
        method === "profile" ? profile : undefined,
      );

      io.stdout("Saving provider...");
      if (hasConnectionOptions(connectionOptions)) {
        await io.createOrUpdateProvider(
          provider.byokProvider.providerType,
          provider.byokProvider.providerName,
          method === "iam" ? secretKey : "",
          method === "iam" ? accessKey : undefined,
          region,
          method === "profile" ? profile : undefined,
          connectionOptions,
        );
      } else {
        await io.createOrUpdateProvider(
          provider.byokProvider.providerType,
          provider.byokProvider.providerName,
          method === "iam" ? secretKey : "",
          method === "iam" ? accessKey : undefined,
          region,
          method === "profile" ? profile : undefined,
        );
      }

      io.stdout(
        `Connected ${provider.byokProvider.displayName} (${provider.byokProvider.providerName}) in ${io.providerStorageTargetLabel()}.`,
      );
      return 0;
    } catch (error) {
      io.stderr(`Failed to connect bedrock: ${getErrorMessage(error)}`);
      return 1;
    }
  }

  if (isConnectApiKeyProvider(provider)) {
    let apiKey =
      readStringOption(parsed.values["api-key"]) ?? restPositionals[0] ?? "";
    let connectionOptions: ProviderConnectionOptions;
    try {
      connectionOptions = connectionOptionsFromArgs(parsed.values);
    } catch (error) {
      io.stderr(getErrorMessage(error));
      return 1;
    }
    if (
      isConnectBaseURLRequired(provider) &&
      !connectionOptions.baseURL?.trim()
    ) {
      io.stderr(
        `Missing base URL for ${provider.canonical}. Pass --base-url <url>.`,
      );
      return 1;
    }

    const nameOption = readStringOption(parsed.values.name);
    if (nameOption !== undefined && nameOption.trim() === "") {
      io.stderr("Provider name cannot be empty.");
      return 1;
    }
    const requestedName = nameOption?.trim();
    if (requestedName && !CONNECT_PROVIDER_NAME_PATTERN.test(requestedName)) {
      io.stderr(
        "Provider name may only contain letters, numbers, dots, underscores, and hyphens.",
      );
      return 1;
    }
    if (requestedName && provider.target === "local") {
      // The local runtime resolves endpoint providers through each spec's
      // fixed localProviderNames, so a custom-named slot would be saved but
      // never surfaced by /model. Reject instead of writing an unusable slot.
      io.stderr(
        `Custom provider names (--name) are not supported for local provider storage yet. Re-run without --name to update '${provider.byokProvider.providerName}'.`,
      );
      return 1;
    }
    const providerName = requestedName ?? provider.byokProvider.providerName;

    try {
      if (provider.target !== "local") {
        await io.ensureSettingsReady();
      }

      // The API-key connect flow writes one provider slot keyed by the
      // provider name. When that slot is occupied by a different provider
      // type or endpoint, replacing it silently can repoint models at another
      // billing account, so the replacement must be explicit. The lookup is
      // strict: a failed check must abort, not bypass the guard.
      let existingProvider: ProviderResponse | null;
      try {
        existingProvider = await io.getProviderByNameStrict(providerName, {
          target: provider.target,
        });
      } catch (error) {
        io.stderr(
          `Could not check for an existing provider named '${providerName}' in ${io.providerStorageTargetLabel()}: ${getErrorMessage(error)}. Nothing was changed.`,
        );
        return 1;
      }
      if (
        existingProvider &&
        overwriteChangesSlot(
          existingProvider,
          provider.byokProvider.providerType,
          connectionOptions.baseURL,
        )
      ) {
        io.stdout(
          `A provider named '${providerName}' already exists in ${io.providerStorageTargetLabel()}.\n` +
            `  Existing: ${formatProviderSlot(existingProvider)}\n` +
            `  New:      ${formatProviderSlot({
              name: providerName,
              provider_type: provider.byokProvider.providerType,
              base_url: connectionOptions.baseURL,
            })}\n` +
            `Saving will replace the existing provider configuration.`,
        );
        const overwrite =
          parsed.values.force === true ||
          (await io.confirmOverwrite(
            `Overwrite provider '${providerName}'? (y/N) `,
          ));
        if (!overwrite) {
          const alternativeAdvice =
            provider.target === "local"
              ? "Re-run with --force to overwrite it."
              : "Re-run with --force to overwrite it, or pass --name to save this connection under a different provider name.";
          io.stderr(
            `Aborted. Provider '${providerName}' was not changed. ${alternativeAdvice}`,
          );
          return 1;
        }
      }

      apiKey ||= defaultConnectApiKey(provider) ?? "";
      if (!apiKey && isConnectZaiBaseProvider(provider)) {
        io.stdout(
          "Do you have a Z.ai Coding plan?\n" +
            "  • Coding plan:  letta connect zai-coding [--api-key <key>]\n" +
            "  • Regular API:  letta connect zai [--api-key <key>]",
        );
        return 0;
      }
      if (!apiKey) {
        if (!io.isTTY()) {
          io.stderr(
            `Missing API key for ${provider.canonical}. Pass as positional arg or --api-key.`,
          );
          return 1;
        }
        apiKey = await io.promptSecret(
          `${provider.byokProvider.displayName} API key: `,
        );
      }

      if (!apiKey) {
        io.stderr("API key cannot be empty.");
        return 1;
      }

      io.stdout(`Validating ${provider.byokProvider.displayName} API key...`);
      if (hasConnectionOptions(connectionOptions)) {
        // The API key must be validated against the user-supplied endpoint, not
        // the provider's default one, or third-party keys fail with a 401.
        await io.checkProviderApiKey(
          provider.byokProvider.providerType,
          apiKey,
          undefined,
          undefined,
          undefined,
          { connection: connectionOptions },
        );
      } else {
        await io.checkProviderApiKey(
          provider.byokProvider.providerType,
          apiKey,
        );
      }

      io.stdout("Saving provider...");
      if (hasConnectionOptions(connectionOptions)) {
        await io.createOrUpdateProvider(
          provider.byokProvider.providerType,
          providerName,
          apiKey,
          undefined,
          undefined,
          undefined,
          connectionOptions,
        );
      } else {
        await io.createOrUpdateProvider(
          provider.byokProvider.providerType,
          providerName,
          apiKey,
        );
      }

      io.stdout(
        `Connected ${provider.byokProvider.displayName} (${providerName}) in ${io.providerStorageTargetLabel()}.`,
      );
      return 0;
    } catch (error) {
      io.stderr(
        `Failed to connect ${provider.byokProvider.displayName}: ${getErrorMessage(error)}`,
      );
      return 1;
    }
  }

  io.stderr("Unsupported provider configuration.");
  return 1;
}
