import { describe, expect, spyOn, test } from "bun:test";
import { configureBackendMode, getBackend } from "@/backend";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { createSdkSpawnerHandle } from "@/tools/impl/workflow";
import * as sdkLoader from "@/tools/workflow/sdk-loader";
import type { SdkClient } from "@/tools/workflow/types";

setupRuntimeModelCatalogFixture();

describe("workflow parent limit forwarding", () => {
  test.each([
    {
      backendMode: "api",
      conversationModel: "openai/gpt-5.6-luna",
      workflowModel: undefined,
      childModel: undefined,
      inherits: true,
    },
    {
      backendMode: "api",
      conversationModel: "openai/gpt-5.6-luna",
      workflowModel: undefined,
      childModel: "gpt-5.6-luna",
      inherits: true,
    },
    {
      backendMode: "api",
      conversationModel: "openai/gpt-5.6-luna",
      workflowModel: "gpt-5.6-luna",
      childModel: undefined,
      inherits: true,
    },
    {
      backendMode: "api",
      conversationModel: "openai/gpt-5.6-luna",
      workflowModel: "sonnet",
      childModel: undefined,
      inherits: false,
    },
    {
      backendMode: "api",
      conversationModel: "openai/gpt-5.6-luna",
      workflowModel: "sonnet",
      childModel: "gpt-5.6-luna",
      inherits: true,
    },
    {
      backendMode: "local",
      conversationModel: "openai/gpt-5.6-luna",
      workflowModel: "sonnet",
      childModel: undefined,
      inherits: false,
    },
    {
      backendMode: "local",
      conversationModel: null,
      workflowModel: "sonnet",
      childModel: undefined,
      inherits: false,
    },
  ] as const)(
    "$backendMode: workflow=$workflowModel child=$childModel",
    async ({
      backendMode,
      workflowModel,
      childModel,
      inherits,
      conversationModel,
    }) => {
      configureBackendMode(backendMode);
      const backend = getBackend();
      const agent = spyOn(backend, "retrieveAgent").mockResolvedValue({
        id: "agent-parent",
        model: "openai/gpt-5.6-luna",
      } as Awaited<ReturnType<typeof backend.retrieveAgent>>);
      const conversation = spyOn(
        backend,
        "retrieveConversation",
      ).mockResolvedValue({
        id: "conv-parent",
        agent_id: "agent-parent",
        model: conversationModel,
        model_settings: { max_output_tokens: 24000 },
        context_window_limit: 256000,
      } as Awaited<ReturnType<typeof backend.retrieveConversation>>);
      const calls: Record<string, unknown>[] = [];
      const client: SdkClient = {
        query({ options }) {
          calls.push(options);
          return {
            conversationId: "conv-worker",
            agentId: null,
            async *[Symbol.asyncIterator]() {
              yield { type: "result", success: true, result: "done" };
            },
            async interrupt() {},
            close() {},
          };
        },
      };
      const sdk = spyOn(sdkLoader, "loadAgentSdk").mockResolvedValue({
        createLocalClient: () => client,
        supportsAgentFreeResume: true,
      });
      try {
        const handle = await createSdkSpawnerHandle({
          model: workflowModel,
          parentScope: {
            agentId: "agent-parent",
            conversationId: "conv-parent",
          },
        });
        try {
          const outcome = await handle.spawner(
            { prompt: "probe", options: { model: childModel }, callIndex: 0 },
            new AbortController().signal,
          );
          expect(outcome.value).toBe("done");
          if (backendMode === "api") {
            expect(agent).toHaveBeenCalledTimes(1);
            expect(conversation).toHaveBeenCalledTimes(1);
          }
          if (inherits)
            expect(calls[0]).toMatchObject({
              modelSettings: { max_output_tokens: 24000 },
              contextWindowLimit: 256000,
            });
          else {
            expect(calls[0]?.modelSettings).toBeUndefined();
            expect(calls[0]?.contextWindowLimit).toBeUndefined();
          }
        } finally {
          await handle.cleanup();
        }
      } finally {
        sdk.mockRestore();
        conversation.mockRestore();
        agent.mockRestore();
        configureBackendMode("api");
      }
    },
  );
});
