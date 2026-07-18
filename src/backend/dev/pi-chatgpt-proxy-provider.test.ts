import { describe, expect, test } from "bun:test";
import type {
  AssistantMessageEventStream,
  ProviderStreams,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createChatGPTResponsesProxyProvider } from "./pi-chatgpt-proxy-provider";

function emptyStream(): AssistantMessageEventStream {
  return {} as AssistantMessageEventStream;
}

describe("createChatGPTResponsesProxyProvider", () => {
  test("publishes Codex models through the standard Responses API", async () => {
    const provider = createChatGPTResponsesProxyProvider({
      upstream: openaiCodexProvider(),
      route: {
        baseURL: "https://proxy.example.test/codex/",
        providerAlias: "chatgpt-plus-pro",
      },
    });
    const model = provider.getModels()[0];

    expect(provider.baseUrl).toBe("https://proxy.example.test/codex");
    expect(provider.headers).toMatchObject({
      "X-Letta-Provider-Alias": "chatgpt-plus-pro",
    });
    expect(model).toMatchObject({
      provider: "openai-codex",
      api: "openai-responses",
      baseUrl: "https://proxy.example.test/codex",
    });

    const auth = await provider.auth.oauth?.toAuth({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-id",
    });
    expect(auth).toMatchObject({
      apiKey: "access-token",
      headers: { "chatgpt-account-id": "account-id" },
    });
  });

  test("raw Responses dispatch omits streamSimple maxTokens defaults", () => {
    let rawOptions: StreamOptions | undefined;
    const responses: ProviderStreams = {
      stream: (_model, _context, options) => {
        rawOptions = options;
        return emptyStream();
      },
      streamSimple: () => {
        throw new Error("proxy route must bypass streamSimple");
      },
    };
    const provider = createChatGPTResponsesProxyProvider({
      upstream: openaiCodexProvider(),
      route: {
        baseURL: "https://proxy.example.test/codex",
        providerAlias: "chatgpt-plus-pro",
      },
      responses,
    });
    const model = provider.getModels()[0];
    if (!model) throw new Error("Expected proxied ChatGPT model");

    provider.streamSimple(
      model,
      { messages: [] },
      {
        apiKey: "access-token",
        maxTokens: 16_384,
        reasoning: "high",
      },
    );

    expect(rawOptions).toMatchObject({
      apiKey: "access-token",
      reasoningEffort: "high",
    });
    expect(rawOptions).not.toHaveProperty("maxTokens");
  });
});
