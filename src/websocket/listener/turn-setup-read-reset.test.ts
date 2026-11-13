import { expect, test } from "bun:test";
import { Letta } from "@letta-ai/letta-client";
import { __testSetBackend, APIBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  createListenerModAdapter,
  disposeListenerModAdapter,
} from "./mod-adapter";
import { handleIncomingMessage } from "./turn";

test.each(["body", "wrapped"])(
  "fresh turn retries %s reset in conversation setup and finishes",
  async (shape) => {
    const directory = new TestDirectory();
    const restoreEnv = isolateAmbientLettaTestEnv();
    const priorConfig = process.env.LETTA_CONFIG_DIR;
    process.env.LETTA_CONFIG_DIR = directory.path;
    await settingsManager.reset();
    const listener = createRuntime();
    listener.modAdapter = createListenerModAdapter({
      globalModsDirectory: directory.createDir("mods"),
      cacheDirectory: directory.createDir("cache"),
    });
    const conversationId = "conv-reset-test";
    let reads = 0;
    let sends = 0;
    const reset = Object.assign(
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ),
      { code: "ECONNRESET" },
    );
    const client = new Letta({
      apiKey: "test",
      baseURL: "http://localhost.invalid",
      // Exercise the SDK wrapper after its fetch retries are exhausted.
      ...(shape === "wrapped" ? { maxRetries: 0 } : {}),
      fetch: async (url, init) => {
        if (init?.method === "GET") {
          expect(String(url)).toBe(
            `http://localhost.invalid/v1/conversations/${conversationId}`,
          );
          reads++;
          if (reads === 1) {
            if (shape === "wrapped") throw reset;
            // Fetch succeeded: SDK retries do not cover response.json().
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(reset);
                },
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
          return Response.json({
            id: conversationId,
            model: "openai/gpt-4.1",
            model_settings: { provider_type: "openai" },
          });
        }
        sends++;
        return new Response(
          'data: {"message_type":"stop_reason","stop_reason":"end_turn"}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    __testSetBackend(new APIBackend({ getClient: async () => client }));
    const runtime = getOrCreateScopedRuntime(listener, null, conversationId);
    runtime.skillSources = [];
    const events: Array<Record<string, unknown>> = [];
    try {
      await handleIncomingMessage(
        {
          type: "message",
          conversationId,
          messages: [{ role: "user", content: "hello" }],
          clientToolset: { base: "default" },
        },
        {
          kind: "local",
          bufferedAmount: 0,
          isOpen: () => true,
          send: (payload: string) => {
            events.push(JSON.parse(payload));
          },
        },
        runtime,
      );
      expect(reads).toBe(2);
      expect(sends).toBe(1);
      expect(runtime.lastStopReason).toBe("end_turn");
      expect(events.some((event) => event.stop_reason === "error")).toBe(false);
    } finally {
      __testSetBackend(null);
      clearCapturedToolExecutionContexts();
      disposeListenerModAdapter(listener);
      await settingsManager.reset();
      if (priorConfig === undefined) delete process.env.LETTA_CONFIG_DIR;
      else process.env.LETTA_CONFIG_DIR = priorConfig;
      restoreEnv();
      directory.cleanup();
    }
  },
);
