import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { parseLocalProviderTimeout } from "@/backend/local/local-provider-timeout";
import {
  type LocalOAuthConnectCallbacks,
  runLocalOAuthConnectFlow,
} from "@/cli/commands/connect-local-oauth";
import {
  defaultConnectApiKey,
  isConnectApiKeyProvider,
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
import {
  checkProviderApiKey,
  createOrUpdateProvider,
  type ProviderConnectionOptions,
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
} as const;

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
  isChatGPTOAuthConnected: (providerName?: string) => Promise<boolean>;
  runChatGPTOAuthConnectFlow: (
    callbacks: ChatGPTOAuthFlowCallbacks,
  ) => Promise<unknown>;
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
  isChatGPTOAuthConnected: (providerName) =>
    isChatGPTOAuthConnected({
      getProvider: () =>
        getOpenAICodexProvider({}, providerName ?? OPENAI_CODEX_PROVIDER_NAME),
    }),
  runChatGPTOAuthConnectFlow,
  runLocalOAuthConnectFlow,
  providerStorageTargetLabel,
};

function formatUsage(): string {
  return [
    "Usage:",
    "  letta connect <provider> [options]",
    "",
    "Providers:",
    `  ${listConnectProvidersForHelp().join("\n  ")}`,
    "",
    "Examples:",
    "  letta connect chatgpt",
    "  letta connect chatgpt --name chatgpt-work",
    "  letta connect codex",
    "  letta connect codex --method device-code",
    "  letta connect anthropic <api_key>",
    "  letta connect openai --api-key <api_key>",
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
    io.stdout(formatUsage());
    return 0;
  }

  const provider = resolveConnectProvider(providerToken);
  if (!provider) {
    io.stderr(
      `Unknown provider: ${providerToken}. Supported providers: ${listConnectProviderTokens().join(", ")}`,
    );
    return 1;
  }

  if (isConnectOAuthProvider(provider)) {
    try {
      if (provider.target !== "local") {
        await io.ensureSettingsReady();
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

    try {
      io.stdout(`Validating ${provider.byokProvider.displayName} API key...`);
      if (provider.target !== "local") {
        await io.ensureSettingsReady();
      }
      await io.checkProviderApiKey(provider.byokProvider.providerType, apiKey);

      io.stdout("Saving provider...");
      if (hasConnectionOptions(connectionOptions)) {
        await io.createOrUpdateProvider(
          provider.byokProvider.providerType,
          provider.byokProvider.providerName,
          apiKey,
          undefined,
          undefined,
          undefined,
          connectionOptions,
        );
      } else {
        await io.createOrUpdateProvider(
          provider.byokProvider.providerType,
          provider.byokProvider.providerName,
          apiKey,
        );
      }

      io.stdout(
        `Connected ${provider.byokProvider.displayName} (${provider.byokProvider.providerName}) in ${io.providerStorageTargetLabel()}.`,
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
