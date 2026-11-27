import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import * as repositorySync from "@/agent/attached-repository-git-sync";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { handleIncomingMessage } from "./turn";
import { shouldRetryPostStopTurn } from "./turn-send";

test("a provider retry sends input queued while the first request fails", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "listener-retry-"));
  const backend = new LocalBackend({
    storageDir,
    executionMode: "deterministic",
    memfsEnabled: false,
  });
  const sync = spyOn(
    repositorySync,
    "syncPendingAttachedRepositoryCommitsAfterTurn",
  ).mockResolvedValue({ results: [] });

  try {
    __testSetBackend(backend);
    await settingsManager.initialize();
    const agent = await backend.createAgent({
      name: "Provider retry",
      model: "anthropic/claude-sonnet-4-6",
    });
    settingsManager.setMemfsEnabled(agent.id, false);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      agent.id,
      conversation.id,
    );
    const scope = { agentId: agent.id, conversationId: conversation.id };
    const request = spyOn(backend, "createConversationMessageStream");
    request.mockImplementation(async () => {
      const firstRequest = request.mock.calls.length === 1;
      return {
        controller: new AbortController(),
        async *[Symbol.asyncIterator]() {
          if (firstRequest) {
            enqueueInboundUserMessage(
              runtime,
              {
                type: "message",
                ...scope,
                messages: [
                  {
                    role: "user",
                    content: "queued instruction",
                    otid: "queued-otid",
                    client_message_id: "queued-client-id",
                  },
                ],
              },
              "queued-user",
            );
          }
          yield {
            run_id: firstRequest ? "run-first" : "run-retry",
            seq_id: 1,
            message_type: "stop_reason",
            stop_reason: firstRequest ? "llm_api_error" : "end_turn",
          };
        },
      } as unknown as Stream<LettaStreamingResponse>;
    });

    await handleIncomingMessage(
      {
        type: "message",
        ...scope,
        messages: [{ role: "user", content: "original instruction" }],
      },
      { kind: "local", bufferedAmount: 0, isOpen: () => true, send: () => {} },
      runtime,
    );

    expect(request).toHaveBeenCalledTimes(2);
    const retryMessages = request.mock.calls[1]?.[1]?.messages;
    expect(retryMessages).toEqual([
      expect.objectContaining({
        content: expect.arrayContaining([
          { type: "text", text: "original instruction" },
        ]),
      }),
      expect.objectContaining({
        content: "queued instruction",
        otid: "queued-otid",
      }),
    ]);
    const options:
      | { headers?: Record<string, string>; signal?: AbortSignal }
      | undefined = request.mock.calls[1]?.[2];
    expect(options?.headers).toMatchObject({
      "X-Letta-Acting-User-Id": "queued-user",
    });
    expect(
      listener.clientMessageIdsByRunIdByConversation
        ?.get(runtime.key)
        ?.get("run-retry"),
    ).toEqual(["queued-client-id"]);
    expect(runtime.queueRuntime.length).toBe(0);
  } finally {
    sync.mockRestore();
    __testSetBackend(null);
    await rm(storageDir, { recursive: true, force: true });
  }
});

test.each([
  "stream sent no output within 60 seconds",
  "Provider stream timeout",
])("post-stop recovery retries %s once", async (errorDetail) => {
  const params = {
    deploymentInterrupted: false,
    deploymentAttempts: 0,
    stopReason: "llm_api_error" as const,
    runId: null,
    errorDetail,
  };
  expect(
    await shouldRetryPostStopTurn({ ...params, providerAttempts: 0 }),
  ).toBe(true);
  expect(
    await shouldRetryPostStopTurn({ ...params, providerAttempts: 1 }),
  ).toBe(false);
  expect(
    await shouldRetryPostStopTurn({
      ...params,
      errorDetail: "Network error",
      providerAttempts: 2,
    }),
  ).toBe(true);
});
