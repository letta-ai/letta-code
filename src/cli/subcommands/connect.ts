import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import {
  checkProviderApiKey,
  createOrUpdateProvider,
} from "../../providers/byok-providers";
import { getErrorMessage } from "../../utils/error";
import {
  isConnectApiKeyProvider,
  isConnectBedrockProvider,
  isConnectOAuthProvider,
  listConnectProvidersForHelp,
  listConnectProviderTokens,
  resolveConnectProvider,
} from "../commands/connect-normalize";
import {
  type ChatGPTOAuthFlowCallbacks,
  isChatGPTOAuthConnected,
  runChatGPTOAuthConnectFlow,
} from "../commands/connect-oauth-core";

const CONNECT_OPTIONS = {
  help: { type: "boolean", short: "h" },
  "api-key": { type: "string" },
  method: { type: "string" },
  "access-key": { type: "string" },
  "secret-key": { type: "string" },
  region: { type: "string" },
  profile: { type: "string" },
} as const;

interface ConnectSubcommandDeps {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  isTTY: () => boolean;
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
  ) => Promise<unknown>;
  isChatGPTOAuthConnected: () => Promise<boolean>;
  runChatGPTOAuthConnectFlow: (
    callbacks: ChatGPTOAuthFlowCallbacks,
  ) => Promise<unknown>;
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
  promptSecret: promptSecret,
  checkProviderApiKey,
  createOrUpdateProvider,
  isChatGPTOAuthConnected,
  runChatGPTOAuthConnectFlow,
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
    "  letta connect codex",
    "  letta connect anthropic <api_key>",
    "  letta connect openai --api-key <api_key>",
    "  letta connect bedrock --method iam --access-key <id> --secret-key <key> --region <region>",
    "  letta connect bedrock --method profile --profile <name> --region <region>",
  ].join("\n");
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
      if (await io.isChatGPTOAuthConnected()) {
        io.stdout(
          "Already connected to ChatGPT via OAuth. Disconnect first if you want to re-authenticate.",
        );
        return 0;
      }

      await io.runChatGPTOAuthConnectFlow({
        onStatus: (status) => io.stdout(status),
      });

      io.stdout("Successfully connected to ChatGPT OAuth.");
      return 0;
    } catch (error) {
      io.stderr(`Failed to connect ChatGPT OAuth: ${getErrorMessage(error)}`);
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
      await io.checkProviderApiKey(
        provider.byokProvider.providerType,
        method === "iam" ? secretKey : "",
        method === "iam" ? accessKey : undefined,
        region,
        method === "profile" ? profile : undefined,
      );

      io.stdout("Saving provider...");
      await io.createOrUpdateProvider(
        provider.byokProvider.providerType,
        provider.byokProvider.providerName,
        method === "iam" ? secretKey : "",
        method === "iam" ? accessKey : undefined,
        region,
        method === "profile" ? profile : undefined,
      );

      io.stdout(
        `Connected ${provider.byokProvider.displayName} (${provider.byokProvider.providerName}).`,
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
      await io.checkProviderApiKey(provider.byokProvider.providerType, apiKey);

      io.stdout("Saving provider...");
      await io.createOrUpdateProvider(
        provider.byokProvider.providerType,
        provider.byokProvider.providerName,
        apiKey,
      );

      io.stdout(
        `Connected ${provider.byokProvider.displayName} (${provider.byokProvider.providerName}).`,
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
