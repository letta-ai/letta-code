import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { buildModelSettings } from "@/agent/modify";
import { PiStreamAdapter } from "@/backend/dev/pi-stream-adapter";
import {
  createOrUpdateLocalProvider,
  setLocalOAuthProvider,
} from "@/backend/local/local-provider-auth-store";

test.each(["openai-responses", "openai-codex-responses"] as const)(
  "local verbosity reaches the real %s request builder",
  async (api) => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-sampling-"));
    const sampling = {
      reasoning: { effort: "high", summary: "detailed" },
      text: { format: { type: "text" } },
    };
    let payload: unknown;
    let capturedContext: Context | undefined;
    const modelHandle =
      api === "openai-codex-responses"
        ? "openai-codex/gpt-5.6-sol"
        : "openai/gpt-5.6-sol";
    try {
      if (api === "openai-codex-responses") {
        setLocalOAuthProvider({
          storageDir,
          providerType: "chatgpt_oauth",
          providerName: "lc-chatgpt",
          auth: {
            type: "oauth",
            access: "test-access",
            refresh: "test-refresh",
            expires: Date.now() + 3_600_000,
            accountId: "test-account",
          },
        });
      } else {
        await createOrUpdateLocalProvider({
          storageDir,
          providerType: "openai",
          providerName: "lc-openai",
          apiKey: "unused-test-key",
        });
      }
      const settings = buildModelSettings(
        modelHandle,
        {
          reasoning_effort: "high",
          verbosity: "high",
          sampling_params: sampling,
        },
        true,
      );
      const adapter = new PiStreamAdapter({
        localProviderAuthStorageDir: storageDir,
        stream: (model, context, options) => {
          capturedContext = context;
          if (model.api !== api) {
            throw new Error(`Expected ${api}, received ${model.api}`);
          }
          const requestOptions = {
            ...options,
            apiKey: `header.${btoa(
              JSON.stringify({
                "https://api.openai.com/auth": {
                  chatgpt_account_id: "test-account",
                },
              }),
            )}.signature`,
            // Run adapter hooks before capturing the final provider request.
            onPayload: async (request: unknown, requestModel: typeof model) => {
              payload =
                (await options?.onPayload?.(request, requestModel)) ?? request;
              throw new Error("captured request without inference");
            },
          };
          return api === "openai-codex-responses"
            ? streamCodex(
                { ...model, api },
                normalizeContext(context),
                requestOptions,
              )
            : streamSimple(
                { ...model, api },
                normalizeContext(context),
                requestOptions,
              );
        },
      });
      try {
        for await (const _event of adapter.stream({
          conversationId: "sampling-test",
          agentId: "agent-local-sampling",
          agent: {
            id: "agent-local-sampling",
            name: "Sampling test",
            description: null,
            system: "Reply briefly.",
            tags: [],
            model: modelHandle,
            model_settings: { ...settings },
          },
          body: { messages: [] },
          history: [],
          uiMessages: [
            { id: "hello", role: "user", content: "Hi", timestamp: Date.now() },
          ],
          midConversationSystemPrompt: "Use the freshly committed memory.",
          clientTools: [],
          clientSkills: [],
        })) {
          // Drain through the provider boundary.
        }
      } catch (error) {
        expect(String(error)).toContain("captured request without inference");
      }
      expect(payload).toMatchObject({
        model: "gpt-5.6-sol",
        text: { verbosity: "high" },
      });
      if (api === "openai-responses") {
        expect(payload).toMatchObject(sampling);
      }
      expect(capturedContext?.messages.at(-1)).toMatchObject({
        role: "system",
        content: "Use the freshly committed memory.",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  },
);

test("sampling overrides are local-only and absent by default", () => {
  const overrides = { sampling_params: { text: { verbosity: "low" } } };
  expect(
    buildModelSettings("openai/gpt-5.6-sol", overrides),
  ).not.toHaveProperty("sampling_params");
  expect(buildModelSettings("openai/gpt-5.6-sol", {}, true)).not.toHaveProperty(
    "sampling_params",
  );
});
