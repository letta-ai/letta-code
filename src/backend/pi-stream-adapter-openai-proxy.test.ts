import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiStreamAdapter } from "@/backend/dev/pi-stream-adapter";
import type { ProviderTurnInput } from "@/backend/dev/provider-turn-executor";
import {
  createOrUpdateLocalProvider,
  LOCAL_CHATGPT_PROVIDER_NAME,
} from "@/backend/local/local-provider-auth-store";

function input(): ProviderTurnInput {
  return {
    conversationId: "local-conv-1",
    agentId: "agent-local-1",
    agent: {
      id: "agent-local-1",
      name: "Local",
      description: null,
      system: "system",
      tags: [],
      model: "openai-codex/gpt-5.5",
      model_settings: {
        provider_type: "chatgpt_oauth",
        max_tokens: 16_384,
      },
    },
    body: { messages: [] } as never,
    history: [],
    uiMessages: [
      { id: "ui-msg-1", role: "user", content: "hello", timestamp: Date.now() },
    ],
    clientTools: [],
    clientSkills: [],
  };
}

describe("PiStreamAdapter ChatGPT proxy routing", () => {
  test("sends standard Responses JSON without max_output_tokens", async () => {
    let requestPath: string | undefined;
    let requestHeaders: Headers | undefined;
    let requestBody: Record<string, unknown> | undefined;
    let markRequestCaptured: (() => void) | undefined;
    const requestCaptured = new Promise<void>((resolve) => {
      markRequestCaptured = resolve;
    });
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        requestHeaders = request.headers;
        requestBody = (await request.json()) as Record<string, unknown>;
        markRequestCaptured?.();

        return Response.json(
          { error: { message: "request captured" } },
          { status: 400 },
        );
      },
    });
    const storageDir = await mkdtemp(
      join(tmpdir(), "pi-stream-chatgpt-proxy-"),
    );

    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "chatgpt_oauth",
        providerName: LOCAL_CHATGPT_PROVIDER_NAME,
        apiKey: JSON.stringify({
          access_token: "access-token",
          id_token: "id-token",
          account_id: "account-id",
          expires_at: Date.now() + 60_000,
        }),
        baseURL: `http://127.0.0.1:${server.port}/codex`,
      });

      const abort = new AbortController();
      const drain = (async () => {
        for await (const _event of new PiStreamAdapter({
          abortSignal: abort.signal,
          localProviderAuthStorageDir: storageDir,
        }).stream(input())) {
          // Drain until the captured request is aborted.
        }
      })();

      await requestCaptured;
      abort.abort();
      await drain.catch((error) => {
        if (!abort.signal.aborted) throw error;
      });

      expect(requestPath).toBe("/codex/responses");
      expect(requestBody).toMatchObject({
        model: "gpt-5.5",
        stream: true,
      });
      expect(requestBody).not.toHaveProperty("max_output_tokens");
      expect(requestHeaders?.get("authorization")).toBe("Bearer access-token");
      expect(requestHeaders?.get("chatgpt-account-id")).toBe("account-id");
      expect(requestHeaders?.get("x-letta-provider-alias")).toBe(
        LOCAL_CHATGPT_PROVIDER_NAME,
      );
      expect(requestHeaders?.get("content-encoding")).toBeNull();
    } finally {
      server.stop(true);
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
