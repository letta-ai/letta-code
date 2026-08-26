import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  AppServerClient,
  type AppServerSocketConstructor,
} from "@/app-server-client";
import { type Backend, configureBackendMode, getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import type { WsProtocolMessage } from "@/types/app-server-protocol";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";

const runIntegration =
  process.env.LETTA_RUN_API_INTEGRATION_TESTS === "true" &&
  !!process.env.LETTA_API_KEY;
const describeIntegration = runIntegration ? describe : describe.skip;

function waitForTurn(
  client: AppServerClient,
  conversationId: string,
): Promise<WsProtocolMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: WsProtocolMessage[] = [];
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for agent-free turn")),
      20_000,
    );
    const unsubscribe = client.onMessage((message) => {
      if (
        !("runtime" in message) ||
        message.runtime?.conversation_id !== conversationId
      )
        return;
      messages.push(message);
      if (message.type !== "turn_finished") return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(messages);
    });
  });
}

describeIntegration("agent-free Cloud App Server", () => {
  let backend: Backend;
  let server: AppServerHandle;
  let client: AppServerClient;
  let conversationId: string | null = null;

  beforeAll(async () => {
    process.env.LETTA_DISABLE_MODS = "1";
    process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
    await settingsManager.initialize();
    configureBackendMode("api");
    backend = getBackend();
    server = await startAppServer({ listen: "ws://127.0.0.1:0" });
    client = await new AppServerClient({
      url: server.controlUrl,
      WebSocket: WebSocket as unknown as AppServerSocketConstructor,
    }).connect();
  });

  afterAll(async () => {
    if (conversationId && backend.deleteConversation) {
      await backend.deleteConversation(conversationId);
    }
    client?.close();
    await server?.close();
  });

  test("creates, runs, and resumes an agent-free conversation", async () => {
    const started = await client.runtimeStart({
      create_conversation: {
        body: {
          model: "openai/gpt-5.6-luna",
          system:
            "Reply with exactly APP_SERVER_AGENT_FREE_OK and do not call tools.",
        },
      },
      skill_sources: [],
      recover_approvals: false,
      wait_for_replay: true,
    });
    expect(started).toMatchObject({
      success: true,
      agent: null,
      created: { agent: false, conversation: true },
    });
    const runtime = started.runtime;
    expect(runtime?.agent_id).toBeNull();
    conversationId = runtime?.conversation_id ?? null;
    if (!runtime || !conversationId) throw new Error("Missing runtime scope");

    const turn = waitForTurn(client, conversationId);
    client.input({
      runtime,
      payload: {
        kind: "create_message",
        exclude_interactive_tools: true,
        messages: [{ role: "user", content: "Reply now." }],
      },
    });
    const messages = await turn;
    const assistantText = messages
      .flatMap((message) =>
        message.type === "stream_delta" ? [message.delta] : [],
      )
      .flatMap((delta) =>
        delta.message_type === "assistant_message" && "content" in delta
          ? [String(delta.content ?? "")]
          : [],
      )
      .join("");
    expect(assistantText).toBe("APP_SERVER_AGENT_FREE_OK");
    expect(
      messages.some(
        (message) =>
          message.type === "update_device_status" &&
          message.device_status.current_toolset === "codex",
      ),
    ).toBe(true);

    expect(
      await client.runtimeStart({
        conversation_id: conversationId,
        recover_approvals: false,
        wait_for_replay: true,
      }),
    ).toMatchObject({
      success: true,
      agent: null,
      runtime,
      created: { agent: false, conversation: false },
    });
  }, 240_000);
});
