import {
  createTraceSession,
  type ExternalTraceContext,
} from "./external-llm-trace-session";

export async function traceClaudeLaunch(
  context: ExternalTraceContext | undefined,
  env: NodeJS.ProcessEnv,
  sessionId: string,
) {
  const direct = await createTraceSession(
    "claude_code",
    context,
    env,
    env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    sessionId,
  );
  if (!direct) return undefined;
  const managed = await createTraceSession(
    "claude_code",
    context,
    env,
    `${direct.baseUrl.replace(/\/$/, "")}/v1/claude`,
    sessionId,
  );
  env.ANTHROPIC_BASE_URL = direct.url;
  if (managed) env.LETTA_EXTERNAL_TRACE_CLAUDE_URL = managed.url;
  return {
    close: async () => {
      await Promise.all([direct.close(), managed?.close()]);
    },
  };
}

interface ConfigClient {
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function traceCodexLaunch(
  context: ExternalTraceContext | undefined,
  env: NodeJS.ProcessEnv,
  client: ConfigClient,
  createTrace: typeof createTraceSession = createTraceSession,
) {
  if (
    !context ||
    env.LETTA_CODE_TELEM === "0" ||
    env.LETTA_CODE_TELEM === "false" ||
    env.DO_NOT_TRACK === "1"
  )
    return undefined;
  try {
    const configuration = record(
      (await client.request("config/read", { includeLayers: false })).config,
    );
    const providerId =
      typeof configuration.model_provider === "string"
        ? configuration.model_provider
        : "openai";
    const provider = record(record(configuration.model_providers)[providerId]);
    const account = record(
      (await client.request("account/read", { refreshToken: false })).account,
    );
    const configuredUrl =
      provider.base_url ??
      (providerId === "openai"
        ? (configuration.openai_base_url ?? env.OPENAI_BASE_URL)
        : undefined);
    const upstream =
      typeof configuredUrl === "string"
        ? configuredUrl
        : providerId === "openai"
          ? account.type === "chatgpt"
            ? "https://chatgpt.com/backend-api/codex"
            : "https://api.openai.com/v1"
          : undefined;
    if (!upstream || (provider.wire_api && provider.wire_api !== "responses"))
      return undefined;
    const trace = await createTrace("codex", context, env, upstream);
    if (!trace) return undefined;
    const selected = providerId === "openai" ? "letta_trace" : providerId;
    // Keep custom providers' auth/config in their existing file. CLI overrides contain no credentials.
    const overrides: Record<string, string | boolean> = {
      model_provider: selected,
      [`model_providers.${selected}.base_url`]: trace.url,
      [`model_providers.${selected}.supports_websockets`]: false,
    };
    if (providerId === "openai") {
      overrides[`model_providers.${selected}.name`] = "OpenAI trace";
      overrides[`model_providers.${selected}.requires_openai_auth`] = true;
      overrides[`model_providers.${selected}.wire_api`] = "responses";
    }
    return {
      ...trace,
      args: Object.entries(overrides).flatMap(([key, value]) => [
        "-c",
        `${key}=${JSON.stringify(value)}`,
      ]),
      params: { modelProvider: selected },
    };
  } catch {
    return undefined;
  }
}
