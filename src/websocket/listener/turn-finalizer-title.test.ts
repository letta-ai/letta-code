import { expect, spyOn, test } from "bun:test";
import { ACTING_USER_ID_HEADER } from "@/agent/acting-user";
import { __testSetBackend, APIBackend, getBackend } from "@/backend";
import type { SummarizeConversationBody } from "@/backend/api/conversations";
import { createBuffers } from "@/cli/helpers/accumulator";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";
import { LocalListenerTransport } from "./transport";
import { handleIncomingMessage } from "./turn";
import { createTurnCorrelation } from "./turn-correlation";
import { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import {
  createQueuedTurnConsumer,
  createTurnFinalizer,
} from "./turn-finalizer";
import type { IncomingMessage } from "./types";

const agentId = "agent-title";
const generatedTitle = "Observing a Lunar Eclipse";

async function waitForRequest<T>(
  pending: Promise<T>,
  route: string,
): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error(`Timed out waiting for ${route}`)),
    3000,
  );
  try {
    return await Promise.race([pending, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function serveConversation(summaryGate?: Promise<void>) {
  const conversationId = `conv-${crypto.randomUUID()}`;
  const path = `/v1/conversations/${conversationId}`;
  const conversation = { id: conversationId, summary: null as string | null };
  const requests: Array<{ route: string; actor: string | null }> = [];
  const summarized =
    Promise.withResolvers<SummarizeConversationBody["model"]>();
  const written = Promise.withResolvers<string | null>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const route = `${request.method} ${new URL(request.url).pathname}`;
      const actor = request.headers.get(ACTING_USER_ID_HEADER);
      requests.push({ route, actor });
      switch (route) {
        case `POST ${path}/messages`:
          return new Response(
            'data: {"message_type":"assistant_message","content":"Sunlight filters through the atmosphere."}\n\ndata: {"message_type":"stop_reason","stop_reason":"end_turn"}\n\n',
            { headers: { "Content-Type": "text/event-stream" } },
          );
        case `GET ${path}`:
          return Response.json(conversation);
        case `GET /v1/agents/${agentId}`:
          return Response.json({
            id: agentId,
            llm_config: {
              model_endpoint_type: "observatory",
              model: "test-model",
            },
          });
        case "GET /v1/providers":
          return Response.json([
            { name: "observatory", provider_type: "openai" },
          ]);
        case `GET ${path}/messages`:
          return Response.json([
            {
              message_type: "user_message",
              content: "Why does the Moon turn red?",
            },
          ]);
        case `POST ${path}/summarize`: {
          const body = (await request.json()) as SummarizeConversationBody;
          summarized.resolve(body.model);
          await summaryGate;
          return Response.json({ summary: generatedTitle });
        }
        case `PATCH ${path}`: {
          const body = (await request.json()) as Pick<
            typeof conversation,
            "summary"
          >;
          conversation.summary = body.summary;
          written.resolve(actor);
          return Response.json(conversation);
        }
        default:
          return new Response(route, { status: 404 });
      }
    },
  });
  return {
    server,
    conversation,
    requests,
    waitForSummaryRequest: () =>
      waitForRequest(summarized.promise, `POST ${path}/summarize`),
    waitForTitleWrite: () => waitForRequest(written.promise, `PATCH ${path}`),
  };
}

async function withTitleApi(
  run: (api: ReturnType<typeof serveConversation>) => Promise<void>,
  summaryGate?: Promise<void>,
) {
  const api = serveConversation(summaryGate);
  const directory = new TestDirectory();
  const env = {
    LETTA_CONFIG_DIR: directory.path,
    LETTA_BASE_URL: api.server.url.origin,
    LETTA_API_KEY: "test-only",
    LETTA_ACTING_USER_ID: "ambient-user",
  };
  const previousEnv = Object.entries(env).map(
    ([key]) => [key, process.env[key]] as const,
  );
  const previousBackend = getBackend();
  const settingsWereReady = settingsManager.isReady;
  const keychain = spyOn(
    settingsManager,
    "isKeychainAvailable",
  ).mockResolvedValue(false);
  try {
    await settingsManager.reset();
    Object.assign(process.env, env);
    __testSetBackend(new APIBackend());
    await settingsManager.initialize();
    settingsManager.updateSettings({ autoConversationTitles: true });
    await run(api);
  } finally {
    await api.server.stop(true);
    await settingsManager.reset();
    keychain.mockRestore();
    __testSetBackend(previousBackend);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    directory.cleanup();
    if (settingsWereReady) await settingsManager.initialize();
  }
}

async function finishQueuedTurn(
  conversationId: string,
  queuedActor: string | null,
) {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    agentId,
    conversationId,
  );
  const turnLease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  const parkedInput: IncomingMessage = {
    type: "message",
    agentId,
    conversationId,
    messages: [{ role: "user", content: "Tell me about an eclipse" }],
    actingUserId: "user-a",
  };
  const ownership = createTurnDurabilityOwnership();
  ownership.recordInput(parkedInput);
  enqueueInboundUserMessage(
    runtime,
    {
      type: "message",
      agentId,
      conversationId,
      messages: [{ role: "user", content: "Why does the Moon turn red?" }],
      suppressActingUserFallback: queuedActor === null,
    },
    queuedActor ?? undefined,
  );
  const batch = consumeQueuedTurn(runtime);
  if (!batch) throw new Error("Expected a queued continuation");
  await createQueuedTurnConsumer({
    parkedInput,
    turnToolContextId: null,
    runtime,
    ownership,
    interruptedRevisionRef: { current: undefined },
  }).onConsumeQueuedTurn(batch.queuedTurn);
  const finalizer = createTurnFinalizer({
    runtime,
    turnLease,
    ownership,
    agentId,
    conversationId,
    socket: new LocalListenerTransport(),
    buffers: createBuffers(agentId),
    turnCorrelation: createTurnCorrelation(runtime, parkedInput, "batch-title"),
  });
  expect(
    finalizer.finishTurn({ stopReason: "end_turn", agentId, conversationId })
      .finished,
  ).toBe(true);
}

test("a completed listener turn persists a title for an untitled conversation", async () => {
  await withTitleApi(async ({ conversation, waitForTitleWrite }) => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      null,
      conversation.id,
    );
    await handleIncomingMessage(
      {
        type: "message",
        conversationId: conversation.id,
        actingUserId: "user-a",
        messages: [{ role: "user", content: "Why does the Moon turn red?" }],
      },
      new LocalListenerTransport(),
      runtime,
    );
    expect(runtime.lastStopReason).toBe("end_turn");
    expect(await waitForTitleWrite()).toBe("user-a");
    expect(conversation.summary).toBe(generatedTitle);
  });
});

test("a title saved manually while summarization is in flight survives completion", async () => {
  const release = Promise.withResolvers<void>();
  await withTitleApi(async ({ conversation, waitForSummaryRequest }) => {
    const { titleUntitledConversation } = await import(
      "@/agent/conversation-title"
    );
    const job = titleUntitledConversation(conversation.id, agentId, "user-a");
    try {
      await waitForSummaryRequest();
      await getBackend().updateConversation(conversation.id, {
        summary: "My eclipse notes",
      });
    } finally {
      release.resolve();
      await job;
    }
    expect(conversation.summary).toBe("My eclipse notes");
  }, release.promise);
});

test.each(["user-b", null])(
  "queued actor %p owns the title requests for the agent's BYOK model",
  async (actor) => {
    await withTitleApi(async (api) => {
      await finishQueuedTurn(api.conversation.id, actor);
      await api.waitForTitleWrite();
      expect(api.requests.filter((request) => request.actor !== actor)).toEqual(
        [],
      );
      expect(await api.waitForSummaryRequest()).toBe("observatory/test-model");
      expect(api.conversation.summary).toBe(generatedTitle);
    });
  },
);
