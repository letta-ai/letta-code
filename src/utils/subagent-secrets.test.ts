import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Letta from "@letta-ai/letta-client";
import { resolveSubagentSecretEnv } from "@/agent/subagents/subagent-launcher";
import { configureBackendMode } from "@/backend";
import { __testOverrideGetClient } from "@/backend/api/client";
import { clearModTools, registerModTool } from "@/mods/tool-registry";
import { runWithRuntimeContext } from "@/runtime-context";
import { resolveExternalTaskParentAgentId } from "@/tools/impl/task";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { createTempRuntimeScriptCommand } from "@/tools/runtime-script";
import {
  extractSecretEnvFromCommand,
  inheritedAgentSecrets,
} from "@/tools/secret-substitution";
import {
  applySecretBatch,
  clearSecretsCache,
  getVerifiedSecretOwner,
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

test("external Task derives its parent only from persisted agent-free lineage", async () => {
  const previous = process.env.AGENT_ID;
  process.env.AGENT_ID = parent;
  try {
    const linked = await runWithRuntimeContext(
      { agentId: null, conversationId: "conv-child" },
      () => resolveExternalTaskParentAgentId(),
    );
    const parentless = await runWithRuntimeContext(
      { agentId: null, conversationId: "conv-parentless" },
      () => resolveExternalTaskParentAgentId(),
    );
    expect(linked).toBe(parent);
    expect(parentless).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = previous;
  }
});

test("inherited process values are bound to one child runtime, not independent agents", () => {
  const env = {
    LETTA_CODE_AGENT_ROLE: "subagent",
    LETTA_INHERITED_SECRET_NAMES: '["SUBAGENT_CANARY"]',
    LETTA_INHERITED_SECRET_EXECUTION_ID: "agent-child",
    SUBAGENT_CANARY: canary,
    LETTA_PARENT_AGENT_ID: parent,
  };
  runWithRuntimeContext({ agentId: "agent-child" }, () => {
    expect(inheritedAgentSecrets(env)).toEqual({ SUBAGENT_CANARY: canary });
  });
  runWithRuntimeContext({ agentId: "agent-independent" }, () => {
    expect(inheritedAgentSecrets(env)).toEqual({});
  });
  runWithRuntimeContext(
    { agentId: null, conversationId: "conv-parentless" },
    () => {
      expect(inheritedAgentSecrets(env)).toEqual({});
    },
  );
});

test("Task launch fetches current parent secrets only for linked child conversations", async () => {
  const retrieveConversation = async (id: string) =>
    conversations[id] ?? { agent_id: null, parent_agent_id: null };
  const fresh = await resolveSubagentSecretEnv({
    parentAgentId: parent,
    retrieveConversation,
  });
  expect(fresh.SUBAGENT_CANARY).toBe(canary);
  secret = "rotated-for-next-launch";
  const fork = await resolveSubagentSecretEnv({
    parentAgentId: parent,
    existingConversationId: "conv-child",
    retrieveConversation,
  });
  expect(fork.SUBAGENT_CANARY).toBe(secret);
  const nested = await resolveSubagentSecretEnv({
    parentAgentId: "conv-child",
    retrieveConversation,
  });
  expect(nested.SUBAGENT_CANARY).toBe(secret);
  expect(getVerifiedSecretOwner("conv-child")).toBe(parent);
  const independent = await resolveSubagentSecretEnv({
    parentAgentId: parent,
    existingAgentId: other,
    retrieveConversation,
  });
  const misleadingLineage = await resolveSubagentSecretEnv({
    parentAgentId: parent,
    existingConversationId: "conv-independent",
    retrieveConversation,
  });
  const parentless = await resolveSubagentSecretEnv({ retrieveConversation });
  expect(independent).toEqual({});
  expect(misleadingLineage).toEqual({});
  expect(parentless).toEqual({});
  expect(
    requests.filter((request) => request.endsWith("/secrets")),
  ).toHaveLength(3);
});

test("fresh, nested, and resumed scopes resolve only their persisted parent", async () => {
  for (const scope of ["conv-child", "conv-grandchild"]) {
    await initSecretsFromServer(scope);
    expect(loadSecrets(scope)).toEqual({ SUBAGENT_CANARY: canary });
    expect(getVerifiedSecretOwner(scope)).toBe(parent);
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
  expect(getVerifiedSecretOwner("conv-parentless")).toBeNull();
  expect(getVerifiedSecretOwner("conv-child")).toBeNull();
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

test("older concurrent agent refresh cannot overwrite a newer result", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  onSecretRequest = async () => {
    if (++calls === 1) {
      started.resolve();
      await release.promise;
      secret = "older-secret-value";
    } else {
      secret = "newer-secret-value";
    }
  };
  const first = initSecretsFromServer(parent);
  await started.promise;
  await initSecretsFromServer(parent);
  release.resolve();
  await first;
  expect(loadSecrets(parent)).toEqual({
    SUBAGENT_CANARY: "newer-secret-value",
  });
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

test("parentless worker shell strips inherited parent env without a persisted link", async () => {
  await initSecretsFromServer("conv-parentless");
  const previousValue = process.env.SUBAGENT_CANARY;
  const previousNames = process.env.LETTA_INHERITED_SECRET_NAMES;
  const previousRole = process.env.LETTA_CODE_AGENT_ROLE;
  process.env.SUBAGENT_CANARY = canary;
  process.env.LETTA_INHERITED_SECRET_NAMES = '["SUBAGENT_CANARY"]';
  process.env.LETTA_CODE_AGENT_ROLE = "subagent";
  const script = createTempRuntimeScriptCommand(
    "process.stdout.write(process.env.SUBAGENT_CANARY ?? 'absent')",
  );
  try {
    const context = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
      {
        runtimeContext: {
          agentId: null,
          conversationId: "conv-parentless",
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
      },
    );
    try {
      const result = await executeTool(
        "Bash",
        { command: script.command, timeout: 5000 },
        { toolContextId: context.contextId },
      );
      expect(JSON.stringify(result.toolReturn)).toContain("absent");
      expect(JSON.stringify(result.toolReturn)).not.toContain(canary);
    } finally {
      releaseToolExecutionContext(context.contextId);
    }
  } finally {
    script.cleanup();
    if (previousValue === undefined) delete process.env.SUBAGENT_CANARY;
    else process.env.SUBAGENT_CANARY = previousValue;
    if (previousNames === undefined)
      delete process.env.LETTA_INHERITED_SECRET_NAMES;
    else process.env.LETTA_INHERITED_SECRET_NAMES = previousNames;
    if (previousRole === undefined) delete process.env.LETTA_CODE_AGENT_ROLE;
    else process.env.LETTA_CODE_AGENT_ROLE = previousRole;
  }
});

test("non-shell tool output redacts both pre-call and rotated child secrets", async () => {
  await initSecretsFromServer("conv-child");
  const oldValue = canary;
  const newValue = "synthetic-rotated-output-secret";
  const controller = new AbortController();
  registerModTool({
    name: "rotate_secret_for_test",
    description: "Rotate a synthetic secret during execution",
    parameters: { type: "object", properties: {}, required: [] },
    owner: {
      id: "global:/tmp/rotate-secret.ts",
      path: "/tmp/rotate-secret.ts",
      scope: "global",
      generation: 1,
    },
    path: "/tmp/rotate-secret.ts",
    approvalPolicy: "auto",
    requiresApproval: false,
    parallelSafe: true,
    activationSignal: controller.signal,
    run: async () => {
      secret = newValue;
      await initSecretsFromServer(parent);
      return `${oldValue}|${newValue}`;
    },
  });
  try {
    const result = await runWithRuntimeContext(
      { agentId: null, conversationId: "conv-child" },
      () => executeTool("rotate_secret_for_test", {}),
    );
    const output = JSON.stringify(result.toolReturn);
    expect(result.status).toBe("success");
    expect(output).not.toContain(oldValue);
    expect(output).not.toContain(newValue);
    expect(output).toContain("SUBAGENT_CANARY=<REDACTED>");
  } finally {
    controller.abort();
    clearModTools();
  }
});

test("agent-free child Read redacts inherited plaintext in non-shell results", async () => {
  await initSecretsFromServer("conv-child");
  const dir = mkdtempSync(join(tmpdir(), "letta-child-secret-read-"));
  const path = join(dir, "fixture.txt");
  writeFileSync(path, canary);
  const context = await prepareToolExecutionContextForSpecificTools(["Read"], {
    runtimeContext: {
      agentId: null,
      conversationId: "conv-child",
      workingDirectory: dir,
    },
    workingDirectory: dir,
  });
  try {
    const result = await executeTool(
      "Read",
      { file_path: path },
      { toolContextId: context.contextId },
    );
    expect(result.status).toBe("success");
    expect(JSON.stringify(result.toolReturn)).toContain(
      "SUBAGENT_CANARY=<REDACTED>",
    );
    expect(JSON.stringify(result.toolReturn)).not.toContain(canary);
  } finally {
    releaseToolExecutionContext(context.contextId);
    rmSync(dir, { recursive: true, force: true });
  }
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
        command: script.command,
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
