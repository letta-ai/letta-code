import { afterEach, beforeEach, expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import { configureBackendMode } from "@/backend";
import { __testOverrideGetClient } from "@/backend/api/client";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { createTempRuntimeScriptCommand } from "@/tools/runtime-script";
import { extractSecretEnvFromCommand } from "@/tools/secret-substitution";
import {
  applySecretBatch,
  clearSecretsCache,
  initSecretsFromServer,
  loadSecrets,
} from "@/utils/secrets-store";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { ensureSecretsHydratedForAgent } from "@/websocket/listener/secrets-sync";
import { ensureListenerWarmStateForTurn } from "@/websocket/listener/warmup";

// An HTTP contract fixture, not an LLM/provider mock. The production SDK,
// backend, hydration, tool dispatch, shell, and output redaction run unchanged.
const parent = "agent-11111111-1111-4111-8111-111111111111";
const other = "agent-22222222-2222-4222-8222-222222222222";
const canary = "synthetic-subagent-canary-92834";
let server: ReturnType<typeof Bun.serve>;
let requests: string[];
let conversations: Record<
  string,
  { agent_id: string | null; parent_agent_id: string | null }
>;
let secret = canary;
let deny = false;
let onSecretRequest: (() => Promise<void>) | undefined;

beforeEach(() => {
  configureBackendMode("api");
  clearSecretsCache(null);
  requests = [];
  secret = canary;
  deny = false;
  onSecretRequest = undefined;
  conversations = {
    "conv-child": { agent_id: null, parent_agent_id: parent },
    "conv-grandchild": { agent_id: null, parent_agent_id: parent },
    "conv-parentless": { agent_id: null, parent_agent_id: null },
    "conv-independent": { agent_id: other, parent_agent_id: parent },
  };
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (request.method !== "GET") return new Response(null, { status: 405 });
      if (path.startsWith("/v1/conversations/")) {
        const id = path.split("/").at(-1) ?? "";
        const conversation = conversations[id];
        return conversation
          ? Response.json({ id, ...conversation })
          : new Response(null, { status: 404 });
      }
      if (path === `/v1/agents/${parent}/secrets`) {
        await onSecretRequest?.();
        return deny
          ? new Response(null, { status: 403 })
          : Response.json([{ key: "SUBAGENT_CANARY", value: secret }]);
      }
      if (path === `/v1/agents/${other}/secrets`) return Response.json([]);
      return new Response(null, { status: 404 });
    },
  });
  const client = new Letta({
    apiKey: "synthetic-test-key",
    baseURL: server.url.toString(),
    maxRetries: 0,
  });
  __testOverrideGetClient(async () => client);
});

afterEach(() => {
  __testOverrideGetClient(null);
  clearSecretsCache(null);
  server.stop(true);
});

test("fresh, nested, and resumed scopes resolve only their persisted parent", async () => {
  for (const scope of ["conv-child", "conv-grandchild"]) {
    await initSecretsFromServer(scope);
    expect(loadSecrets(scope)).toEqual({ SUBAGENT_CANARY: canary });
  }
  clearSecretsCache(null);
  await initSecretsFromServer("conv-grandchild");
  expect(loadSecrets("conv-grandchild")).toEqual({ SUBAGENT_CANARY: canary });
  expect(requests).toEqual([
    "GET /v1/conversations/conv-child",
    `GET /v1/agents/${parent}/secrets`,
    "GET /v1/conversations/conv-grandchild",
    `GET /v1/agents/${parent}/secrets`,
    "GET /v1/conversations/conv-grandchild",
    `GET /v1/agents/${parent}/secrets`,
  ]);
});

test("parentless and independent scopes do not inherit ambient caller credentials", async () => {
  await initSecretsFromServer(parent);
  await initSecretsFromServer("conv-parentless");
  await initSecretsFromServer("conv-independent");
  await initSecretsFromServer(other);
  expect(loadSecrets("conv-parentless")).toEqual({});
  expect(loadSecrets("conv-independent")).toEqual({});
  expect(loadSecrets(other)).toEqual({});
  const previous = process.env.LETTA_AGENT_ID;
  process.env.LETTA_AGENT_ID = parent;
  try {
    for (const conversationId of ["conv-parentless", undefined]) {
      runWithRuntimeContext({ agentId: null, conversationId }, () => {
        expect(loadSecrets()).toEqual({});
        expect(extractSecretEnvFromCommand("echo $SUBAGENT_CANARY")).toEqual(
          {},
        );
      });
    }
  } finally {
    if (previous === undefined) delete process.env.LETTA_AGENT_ID;
    else process.env.LETTA_AGENT_ID = previous;
  }
});

test("aliases see rotation without copying values and are dropped after denied refresh", async () => {
  await initSecretsFromServer("conv-child");
  secret = "synthetic-rotated-canary";
  await initSecretsFromServer(parent);
  expect(loadSecrets("conv-child")).toEqual({ SUBAGENT_CANARY: secret });
  deny = true;
  await expect(initSecretsFromServer("conv-child")).rejects.toThrow();
  expect(loadSecrets("conv-child")).toEqual({});
});

test.each(["clear", "newer-parentless-refresh"])(
  "pending hydration cannot undo %s",
  async (action) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onSecretRequest = async () => {
      started.resolve();
      await release.promise;
    };
    const pending = initSecretsFromServer("conv-child");
    await started.promise;
    try {
      if (action === "clear") clearSecretsCache("conv-child");
      else {
        conversations["conv-child"] = { agent_id: null, parent_agent_id: null };
        await initSecretsFromServer("conv-child");
      }
    } finally {
      release.resolve();
    }
    await pending;
    expect(loadSecrets("conv-child")).toEqual({});
  },
);

test("inherited scope cannot persist a copied map via secret mutation", async () => {
  await initSecretsFromServer("conv-child");
  await expect(
    applySecretBatch({ set: { EXTRA: "synthetic" } }, "conv-child"),
  ).rejects.toThrow("inherited");
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
});

test("listener null-owned warmup hydrates the same scope used by real shell dispatch", async () => {
  const listener = __listenClientTestUtils.createListenerRuntime();
  await ensureListenerWarmStateForTurn(listener, {
    agentId: null,
    conversationId: "conv-child",
  });
  // Same hydration entry point used by approval continuation/recovery.
  await ensureSecretsHydratedForAgent(listener, "conv-child");
  const context = await prepareToolExecutionContextForSpecificTools(["Bash"], {
    runtimeContext: {
      agentId: null,
      conversationId: "conv-child",
      workingDirectory: process.cwd(),
    },
    workingDirectory: process.cwd(),
  });
  const script = createTempRuntimeScriptCommand(
    "process.stdout.write(process.env.SUBAGENT_CANARY ?? '')",
  );
  try {
    const result = await executeTool(
      "Bash",
      {
        command: `${script.command} $SUBAGENT_CANARY`,
        timeout: 5000,
      },
      { toolContextId: context.contextId },
    );
    expect(result.status).toBe("success");
    const output = JSON.stringify(result.toolReturn);
    expect(output).toContain("SUBAGENT_CANARY=<REDACTED>");
    expect(output).not.toContain(canary);
  } finally {
    releaseToolExecutionContext(context.contextId);
    script.cleanup();
  }
});
