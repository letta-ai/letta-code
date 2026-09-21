import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { type Instance, render } from "ink";
import { WebSocketServer } from "ws";
import { __testSetBackend } from "@/backend";
import {
  type BackendMode,
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
  type HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import { App } from "@/cli/App";
import { __testSetLocalSessionOwnerStarter } from "@/cli/app/use-local-session-owner";
import { settingsManager } from "@/settings-manager";
import { monitor } from "@/tools/impl/monitor";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import {
  addToMessageQueue,
  clearPendingMessages,
  isQueueBridgeConnected,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { formatTaskNotification } from "@/utils/task-notifications";
import type {
  LocalSessionOwnerHandle,
  StartLocalSessionOwnerOptions,
} from "@/websocket/local-session-owner";

class TuiOutputStream extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(10);
  }
  if (!predicate()) {
    throw new Error(`Timed out waiting for ${description}`);
  }
}

function monitorNotification(summary: string): string {
  return formatTaskNotification({
    taskId: "monitor-test",
    status: "completed",
    summary,
    result: "done",
    outputFile: "/tmp/monitor-test.log",
  });
}

/**
 * First turn: a stream that yields nothing until aborted, then ends only when
 * the test releases it (so the test controls when cancellation settles).
 * Every later turn: an immediate assistant reply.
 */
class DelayedInterruptExecutor implements HeadlessTurnExecutor {
  readonly inputs: HeadlessTurnExecutorInput[] = [];
  private releaseInterruptedTurn: (() => void) | null = null;
  private readonly interruptedTurnReleased = new Promise<void>((resolve) => {
    this.releaseInterruptedTurn = resolve;
  });
  private resolveAbortObserved: (() => void) | null = null;
  readonly abortObserved = new Promise<void>((resolve) => {
    this.resolveAbortObserved = resolve;
  });
  async execute(input: HeadlessTurnExecutorInput) {
    this.inputs.push(input);
    if (this.inputs.length > 1) {
      return createAssistantMessageStream();
    }
    const controller = new AbortController();
    const abortObserved = this.resolveAbortObserved;
    const interruptedTurnReleased = this.interruptedTurnReleased;
    return {
      controller,
      async *[Symbol.asyncIterator]() {
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        abortObserved?.();
        await interruptedTurnReleased;
      },
    } as unknown as Stream<LettaStreamingResponse>;
  }
  settleInterruptedTurn(): void {
    this.releaseInterruptedTurn?.();
    this.releaseInterruptedTurn = null;
  }
}

const monitorSources = new Set<WebSocketServer>();
const monitorIds = new Set<string>();

async function startMonitor(scope: {
  agentId: string;
  conversationId: string;
}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  monitorSources.add(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing socket address");
  const connected = new Promise<import("ws").WebSocket>((resolve) =>
    server.once("connection", resolve),
  );
  const result = await monitor({
    description: "Watch interrupt fixture events",
    ws: { url: `ws://127.0.0.1:${address.port}` },
    persistent: true,
    parentScope: scope,
  });
  monitorIds.add(result.taskId);
  const socket = await connected;
  const state = backgroundProcesses.get(result.taskId);
  if (!state) throw new Error("Monitor was not registered");
  let closed = false;
  socket.once("close", () => {
    closed = true;
  });
  return { socket, state, isClosed: () => closed };
}

const renderedInstances = new Set<Instance>();
let previousBackendMode: BackendMode;
let previousHome: string | undefined;
let tempHome: string;

beforeEach(async () => {
  previousBackendMode = resolveBackendMode();
  setConfiguredBackendMode("local");
  clearPendingMessages();
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "letta-tui-interrupt-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterEach(async () => {
  for (const instance of renderedInstances) {
    instance.unmount();
    instance.cleanup();
  }
  renderedInstances.clear();
  for (const id of monitorIds) {
    const state = backgroundProcesses.get(id);
    if (state) {
      state.completionNotificationSuppressed = true;
      state.process.kill();
    }
    clearBackgroundProcessCleanup(id);
    backgroundProcesses.delete(id);
  }
  monitorIds.clear();
  for (const server of monitorSources) {
    for (const socket of server.clients) socket.terminate();
    server.close();
  }
  monitorSources.clear();
  setMessageQueueAdder(null);
  __testSetLocalSessionOwnerStarter(null);
  clearPendingMessages();
  __testSetBackend(null);
  setConfiguredBackendMode(previousBackendMode);
  await settingsManager.reset();
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

async function renderTestApp(executor: HeadlessTurnExecutor): Promise<{
  backend: FakeHeadlessBackend;
  stdin: NodeJS.ReadStream;
  instance: Instance;
  agentState: Awaited<ReturnType<FakeHeadlessBackend["retrieveAgent"]>>;
  conversationId: string;
}> {
  const agentId = "agent-tui-interrupt-queue";
  const backend = new FakeHeadlessBackend(agentId, executor);
  __testSetBackend(backend);
  const agentState = await backend.retrieveAgent(agentId);
  const conversation = await backend.createConversation({ agent_id: agentId });
  const stdin = createInputStream();
  const stdout = new TuiOutputStream() as TuiOutputStream & NodeJS.WriteStream;
  const instance = render(
    <App
      agentId={agentId}
      agentState={agentState}
      conversationId={conversation.id}
      modsDisabled
      systemInfoReminderEnabled={false}
    />,
    {
      stdout,
      stdin,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  renderedInstances.add(instance);
  await waitFor(isQueueBridgeConnected, "the TUI queue bridge to mount");
  return {
    backend,
    stdin,
    instance,
    agentState,
    conversationId: conversation.id,
  };
}

async function typePrompt(stdin: NodeJS.ReadStream, text: string) {
  await sleep(200);
  stdin.push(text);
  await sleep(50);
  stdin.push("\r");
}

describe("TUI interrupt queue lifecycle", () => {
  test("accepted old-scope input drains before a prop switch and new readiness", async () => {
    setConfiguredBackendMode("api");
    const lifecycle: string[] = [];
    const ownerOptions: StartLocalSessionOwnerOptions[] = [];
    let resolveNewReady!: (ready: boolean) => void;
    const newReady = new Promise<boolean>((resolve) => {
      resolveNewReady = resolve;
    });
    __testSetLocalSessionOwnerStarter(async (options) => {
      ownerOptions.push(options);
      const scope = options.conversationId;
      const ownerNumber = ownerOptions.length;
      lifecycle.push(`start:${scope}`);
      return {
        ready: (signal) => {
          if (ownerNumber === 1) return Promise.resolve(true);
          if (!signal) return newReady;
          return Promise.race([
            newReady,
            new Promise<boolean>((_resolve, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                {
                  once: true,
                },
              ),
            ),
          ]);
        },
        forceStop() {},
        stopAdmission() {
          lifecycle.push(`stop:${scope}`);
        },
        resumeAdmission() {
          lifecycle.push(`resume:${scope}`);
        },
        async release() {
          lifecycle.push(`release:${scope}`);
          return true;
        },
      };
    });
    const inputs: HeadlessTurnExecutorInput[] = [];
    const rendered = await renderTestApp({
      async execute(input) {
        inputs.push(input);
        lifecycle.push(`submit:${input.conversationId}`);
        return createAssistantMessageStream();
      },
    });
    await waitFor(() => ownerOptions.length === 1, "the first scoped owner");

    const firstOptions = ownerOptions[0];
    if (!firstOptions) throw new Error("Missing first owner options");
    firstOptions.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "accepted under A",
      agentId: "agent-tui-interrupt-queue",
      conversationId: rendered.conversationId,
      noCoalesce: true,
    } as Parameters<typeof firstOptions.queueRuntime.enqueue>[0]);
    firstOptions.onQueueChanged();
    const secondConversation = await rendered.backend.createConversation({
      agent_id: "agent-tui-interrupt-queue",
    });
    rendered.instance.rerender(
      <App
        agentId="agent-tui-interrupt-queue"
        agentState={rendered.agentState}
        conversationId={secondConversation.id}
        modsDisabled
        systemInfoReminderEnabled={false}
      />,
    );
    await waitFor(() => inputs.length === 1, "accepted A input to execute");
    await waitFor(
      () => ownerOptions.length === 2,
      "the new scoped owner",
      10_000,
    ).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; lifecycle=${lifecycle.join(",")}`,
      );
    });
    expect(JSON.stringify(inputs[0]?.body)).toContain("accepted under A");
    expect(lifecycle.indexOf(`submit:${rendered.conversationId}`)).toBeLessThan(
      lifecycle.indexOf(`release:${rendered.conversationId}`),
    );

    await typePrompt(rendered.stdin, "new scope prompt");
    await sleep(100);
    expect(inputs).toHaveLength(1);
    resolveNewReady(true);
    await waitFor(() => inputs.length === 2, "new scope readiness and run");
  }, 15_000);

  test("Esc cancels only the prompt waiting for owner readiness", async () => {
    setConfiguredBackendMode("api");
    let resolveClaim!: (ready: boolean) => void;
    const claimReady = new Promise<boolean>((resolve) => {
      resolveClaim = resolve;
    });
    let readyCalls = 0;
    let abortedWaits = 0;
    let forcedStops = 0;
    let ownerStarts = 0;
    let releases = 0;
    __testSetLocalSessionOwnerStarter(async () => {
      ownerStarts += 1;
      return {
        ready(signal) {
          readyCalls += 1;
          if (!signal) return claimReady;
          return Promise.race([
            claimReady,
            new Promise<boolean>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  abortedWaits += 1;
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            }),
          ]);
        },
        forceStop() {
          forcedStops += 1;
        },
        stopAdmission() {},
        resumeAdmission() {},
        async release() {
          releases += 1;
          return true;
        },
      };
    });
    const inputs: HeadlessTurnExecutorInput[] = [];
    const rendered = await renderTestApp({
      async execute(input) {
        inputs.push(input);
        return createAssistantMessageStream();
      },
    });

    await typePrompt(rendered.stdin, "wait for claim");
    await waitFor(() => readyCalls > 1, "the prompt readiness wait");
    const secondConversation = await rendered.backend.createConversation({
      agent_id: "agent-tui-interrupt-queue",
    });
    rendered.instance.rerender(
      <App
        agentId="agent-tui-interrupt-queue"
        agentState={rendered.agentState}
        conversationId={secondConversation.id}
        modsDisabled
        systemInfoReminderEnabled={false}
      />,
    );
    await sleep(50);
    rendered.stdin.push("\u001b");
    await waitFor(() => abortedWaits === 1, "Esc to abort the readiness wait");
    await waitFor(() => ownerStarts === 2, "queued switch after cancellation");
    expect(releases).toBeGreaterThan(0);
    expect(forcedStops).toBe(0);
    expect(inputs).toHaveLength(0);

    resolveClaim(true);
    await typePrompt(rendered.stdin, "run after claim");
    await waitFor(() => inputs.length === 1, "the next prompt after readiness");
  }, 15_000);

  test("Esc cancels a prompt while owner registration is still starting", async () => {
    setConfiguredBackendMode("api");
    let resolveOwner!: (owner: LocalSessionOwnerHandle) => void;
    const ownerStartup = new Promise<LocalSessionOwnerHandle>((resolve) => {
      resolveOwner = resolve;
    });
    let startupRequested = false;
    __testSetLocalSessionOwnerStarter(async () => {
      startupRequested = true;
      return await ownerStartup;
    });
    const inputs: HeadlessTurnExecutorInput[] = [];
    const { stdin } = await renderTestApp({
      async execute(input) {
        inputs.push(input);
        return createAssistantMessageStream();
      },
    });
    await waitFor(() => startupRequested, "owner registration startup");
    await typePrompt(stdin, "cancel during registration");
    stdin.push("\u001b");
    await sleep(100);
    expect(inputs).toHaveLength(0);

    resolveOwner({
      ready: async () => true,
      forceStop() {},
      stopAdmission() {},
      resumeAdmission() {},
      release: async () => true,
    });
    await typePrompt(stdin, "run after registration");
    await waitFor(() => inputs.length === 1, "next prompt after registration");
  }, 15_000);

  test("failed prop agent lookup reopens old owner admission", async () => {
    setConfiguredBackendMode("api");
    const lifecycle: string[] = [];
    __testSetLocalSessionOwnerStarter(async () => ({
      ready: async () => true,
      forceStop() {},
      stopAdmission() {
        lifecycle.push("stop");
      },
      resumeAdmission() {
        lifecycle.push("resume");
      },
      async release() {
        lifecycle.push("release");
        return true;
      },
    }));
    const rendered = await renderTestApp({
      async execute() {
        return createAssistantMessageStream();
      },
    });
    await sleep(300);
    const retrieveAgent = rendered.backend.retrieveAgent.bind(rendered.backend);
    rendered.backend.retrieveAgent = async (agentId) => {
      if (agentId === "missing-agent") {
        throw new Error("missing agent");
      }
      return await retrieveAgent(agentId);
    };
    rendered.instance.rerender(
      <App
        agentId="missing-agent"
        agentState={rendered.agentState}
        conversationId={rendered.conversationId}
        modsDisabled
        systemInfoReminderEnabled={false}
      />,
    );
    await waitFor(() => lifecycle.includes("stop"), "old admission to close");
    await waitFor(
      () => lifecycle.includes("resume"),
      "failed lookup to reopen admission",
      10_000,
    );
    expect(lifecycle).not.toContain("release");
  }, 15_000);

  test("double Ctrl-C awaits owner release before clean process exit", async () => {
    setConfiguredBackendMode("api");
    const lifecycle: string[] = [];
    __testSetLocalSessionOwnerStarter(async () => ({
      ready: async () => true,
      forceStop() {},
      stopAdmission() {
        lifecycle.push("stop");
      },
      resumeAdmission() {},
      async release() {
        await sleep(50);
        lifecycle.push("release");
        return true;
      },
    }));
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      lifecycle.push(`exit:${code ?? 0}`);
      return undefined as never;
    }) as typeof process.exit;
    try {
      const { stdin } = await renderTestApp({
        async execute() {
          return createAssistantMessageStream();
        },
      });
      await sleep(200);
      stdin.push("\u0003");
      await sleep(100);
      stdin.push("\u0003");
      await waitFor(() => lifecycle.includes("exit:0"), "clean process exit");
      expect(lifecycle.indexOf("release")).toBeLessThan(
        lifecycle.indexOf("exit:0"),
      );
    } finally {
      process.exit = originalExit;
    }
  }, 15_000);

  test("clean exit settles a failing accepted remote turn before release", async () => {
    setConfiguredBackendMode("api");
    const lifecycle: string[] = [];
    let ownerOptions: StartLocalSessionOwnerOptions | null = null;
    __testSetLocalSessionOwnerStarter(async (options) => {
      ownerOptions = options;
      return {
        ready: async () => true,
        forceStop() {},
        stopAdmission() {
          lifecycle.push("stop");
        },
        resumeAdmission() {},
        async release() {
          expect(options.queueRuntime.length).toBe(0);
          lifecycle.push("release");
          return true;
        },
      };
    });
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      lifecycle.push(`exit:${code ?? 0}`);
      return undefined as never;
    }) as typeof process.exit;
    try {
      const rendered = await renderTestApp({
        async execute() {
          lifecycle.push("turn:start");
          await sleep(75);
          lifecycle.push("turn:finish");
          throw new Error("expected queued exit failure");
        },
      });
      await waitFor(() => ownerOptions !== null, "initial owner");
      const owner = ownerOptions as StartLocalSessionOwnerOptions | null;
      if (!owner) throw new Error("Missing owner options");
      owner.queueRuntime.enqueue({
        kind: "message",
        source: "user",
        content: "accepted before exit",
        agentId: "agent-tui-interrupt-queue",
        conversationId: rendered.conversationId,
        noCoalesce: true,
      } as Parameters<typeof owner.queueRuntime.enqueue>[0]);
      owner.onQueueChanged();
      rendered.stdin.push("\u0003");
      await sleep(10);
      rendered.stdin.push("\u0003");

      await waitFor(() => lifecycle.includes("exit:0"), "drained clean exit");
      expect(lifecycle.indexOf("turn:finish")).toBeLessThan(
        lifecycle.indexOf("release"),
      );
      expect(lifecycle.indexOf("release")).toBeLessThan(
        lifecycle.indexOf("exit:0"),
      );
    } finally {
      process.exit = originalExit;
    }
  }, 15_000);

  test("clean exit discards an Esc-parked local follow-up", async () => {
    setConfiguredBackendMode("api");
    const lifecycle: string[] = [];
    let ownerOptions: StartLocalSessionOwnerOptions | null = null;
    const executor = new DelayedInterruptExecutor();
    __testSetLocalSessionOwnerStarter(async (options) => {
      ownerOptions = options;
      return {
        ready: async () => true,
        forceStop() {},
        stopAdmission() {},
        resumeAdmission() {},
        async release() {
          expect(options.queueRuntime.length).toBe(0);
          lifecycle.push("release");
          return true;
        },
      };
    });
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      lifecycle.push(`exit:${code ?? 0}`);
      return undefined as never;
    }) as typeof process.exit;
    try {
      const rendered = await renderTestApp(executor);
      await waitFor(() => ownerOptions !== null, "initial owner");
      await typePrompt(rendered.stdin, "active turn before parked input");
      await waitFor(() => executor.inputs.length === 1, "active turn");
      const owner = ownerOptions as StartLocalSessionOwnerOptions | null;
      if (!owner) throw new Error("Missing owner options");
      owner.queueRuntime.enqueue({
        kind: "message",
        source: "user",
        content: "park this local follow-up",
      } as Parameters<typeof owner.queueRuntime.enqueue>[0]);
      owner.queueRuntime.enqueue({
        kind: "message",
        source: "user",
        content: "preserve this scoped follow-up",
        agentId: "agent-tui-interrupt-queue",
        conversationId: rendered.conversationId,
      } as Parameters<typeof owner.queueRuntime.enqueue>[0]);
      owner.onQueueChanged();
      rendered.stdin.push("\u001b");
      await executor.abortObserved;
      await waitFor(() => owner.queueRuntime.pausedCount === 2, "Esc pause");

      rendered.stdin.push("\u0003");
      await sleep(10);
      rendered.stdin.push("\u0003");
      await waitFor(
        () => owner.queueRuntime.length === 1,
        "unscoped parked draft removal",
      );
      expect(owner.queueRuntime.peek()[0]).toMatchObject({
        agentId: "agent-tui-interrupt-queue",
        conversationId: rendered.conversationId,
      });
      expect(owner.queueRuntime.peek()[0]?.paused).toBeUndefined();
      expect(lifecycle).not.toContain("release");
      executor.settleInterruptedTurn();
      await waitFor(() => lifecycle.includes("exit:0"), "parked queue exit");
      expect(executor.inputs).toHaveLength(2);
      expect(JSON.stringify(executor.inputs[1]?.body)).toContain(
        "preserve this scoped follow-up",
      );
      expect(lifecycle.indexOf("release")).toBeLessThan(
        lifecycle.indexOf("exit:0"),
      );
    } finally {
      process.exit = originalExit;
    }
  }, 15_000);

  test("direct resume drains paused scoped input before handoff", async () => {
    setConfiguredBackendMode("api");
    const lifecycle: string[] = [];
    const ownerOptions: StartLocalSessionOwnerOptions[] = [];
    __testSetLocalSessionOwnerStarter(async (options) => {
      ownerOptions.push(options);
      lifecycle.push(`start:${options.conversationId}`);
      return {
        ready: async () => true,
        forceStop() {},
        stopAdmission() {},
        resumeAdmission() {},
        async release() {
          await options.waitForAcceptedInputs?.();
          lifecycle.push(`release:${options.conversationId}`);
          return true;
        },
      };
    });
    const executor = new DelayedInterruptExecutor();
    const rendered = await renderTestApp(executor);
    let finishBackendCancel: (() => void) | undefined;
    const backendCancelPending = new Promise<void>((resolve) => {
      finishBackendCancel = resolve;
    });
    const cancelConversation = rendered.backend.cancelConversation.bind(
      rendered.backend,
    );
    rendered.backend.cancelConversation = async (id) => {
      await backendCancelPending;
      return cancelConversation(id);
    };
    await waitFor(() => ownerOptions.length === 1, "initial owner");
    await typePrompt(rendered.stdin, "active turn before direct resume");
    await waitFor(() => executor.inputs.length === 1, "active turn");
    const firstOwner = ownerOptions[0];
    if (!firstOwner) throw new Error("Missing owner options");
    firstOwner.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "keep this parked draft",
    } as Parameters<typeof firstOwner.queueRuntime.enqueue>[0]);
    firstOwner.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "run scoped A before handoff",
      agentId: "agent-tui-interrupt-queue",
      conversationId: rendered.conversationId,
      noCoalesce: true,
    } as Parameters<typeof firstOwner.queueRuntime.enqueue>[0]);
    firstOwner.onQueueChanged();
    rendered.stdin.push("\u001b");
    await executor.abortObserved;
    await waitFor(() => firstOwner.queueRuntime.pausedCount === 2, "Esc pause");

    const secondConversation = await rendered.backend.createConversation({
      agent_id: "agent-tui-interrupt-queue",
    });
    await typePrompt(rendered.stdin, `/resume ${secondConversation.id}`);
    expect(ownerOptions).toHaveLength(1);
    executor.settleInterruptedTurn();
    await sleep(100);
    expect(executor.inputs).toHaveLength(1);
    expect(ownerOptions).toHaveLength(1);
    finishBackendCancel?.();
    await waitFor(() => executor.inputs.length === 2, "scoped A input");
    await waitFor(() => ownerOptions.length === 2, "new conversation owner");
    expect(executor.inputs[1]?.conversationId).toBe(rendered.conversationId);
    expect(JSON.stringify(executor.inputs[1]?.body)).toContain(
      "run scoped A before handoff",
    );
    expect(JSON.stringify(executor.inputs)).not.toContain(
      "keep this parked draft",
    );
    expect(firstOwner.queueRuntime.peek()).toMatchObject([
      {
        content: "keep this parked draft",
        paused: true,
      },
    ]);
    expect(
      lifecycle.indexOf(`release:${rendered.conversationId}`),
    ).toBeLessThan(lifecycle.indexOf(`start:${secondConversation.id}`));
  }, 15_000);

  test("agent creation keeps the old backend until accepted input drains", async () => {
    setConfiguredBackendMode("api");
    const ownerOptions: StartLocalSessionOwnerOptions[] = [];
    __testSetLocalSessionOwnerStarter(async (options) => {
      ownerOptions.push(options);
      return {
        ready: async () => true,
        forceStop() {},
        stopAdmission() {},
        resumeAdmission() {},
        release: async () => true,
      };
    });
    const executionModes: BackendMode[] = [];
    const rendered = await renderTestApp({
      async execute() {
        executionModes.push(resolveBackendMode());
        return createAssistantMessageStream();
      },
    });
    await waitFor(() => ownerOptions.length === 1, "initial owner");
    await typePrompt(rendered.stdin, "/resume");
    await sleep(300);
    const owner = ownerOptions[0];
    if (!owner) throw new Error("Missing owner options");
    owner.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "accepted before backend change",
      agentId: "agent-tui-interrupt-queue",
      conversationId: rendered.conversationId,
      noCoalesce: true,
    } as Parameters<typeof owner.queueRuntime.enqueue>[0]);
    owner.onQueueChanged();
    rendered.stdin.push("N");
    await sleep(200);
    await typePrompt(rendered.stdin, "new backend agent");
    await waitFor(
      () => executionModes.length === 1,
      "old-scope accepted input",
    );
    expect(executionModes[0]).toBe("api");
  }, 15_000);

  test("a real Monitor survives normal completion and idle Esc", async () => {
    const inputs: HeadlessTurnExecutorInput[] = [];
    const { stdin } = await renderTestApp({
      async execute(input) {
        inputs.push(input);
        return createAssistantMessageStream();
      },
    });
    await typePrompt(stdin, "complete normally");
    await waitFor(() => inputs.length === 1, "the normal turn");
    const input = inputs[0];
    if (!input) throw new Error("Missing first turn");
    const source = await startMonitor(input);
    source.socket.send("normal monitor event");
    await waitFor(() => inputs.length === 2, "the Monitor notification turn");
    await sleep(300);
    expect(source.state.status).toBe("running");
    stdin.push("\u001b");
    await sleep(100);
    expect(source.isClosed()).toBe(false);
    source.socket.send("still watching after idle Esc");
    await waitFor(() => inputs.length === 3, "the event after idle Esc");
    expect(JSON.stringify(inputs[2]?.body)).toContain(
      "still watching after idle Esc",
    );
    expect(JSON.stringify(inputs[2]?.body)).not.toContain(
      "Any pending monitors",
    );
    expect(source.state.status).toBe("running");
  }, 15_000);

  test("an idle Monitor notification starts an agent turn without user input", async () => {
    const executor = new DelayedInterruptExecutor();
    await renderTestApp(executor);
    addToMessageQueue({
      kind: "task_notification",
      text: monitorNotification("idle monitor completion"),
    });
    await waitFor(() => executor.inputs.length === 1, "the notification turn");
    expect(JSON.stringify(executor.inputs[0]?.body)).toContain(
      "idle monitor completion",
    );
    executor.settleInterruptedTurn();
  });

  test("typed prompt, notification queued, Esc: the Monitor survives and notifications drain after cancellation", async () => {
    const executor = new DelayedInterruptExecutor();
    const { stdin } = await renderTestApp(executor);
    await typePrompt(stdin, "start turn");
    await waitFor(() => executor.inputs.length === 1, "the typed initial turn");
    const input = executor.inputs[0];
    if (!input) throw new Error("Missing first turn");
    const source = await startMonitor(input);
    source.socket.send("queued before Esc");
    await waitFor(
      () => source.state.stdout.join("\n").includes("queued before Esc"),
      "the real Monitor event to be received",
    );
    await sleep(300);
    stdin.push("\u001b");
    await executor.abortObserved;
    expect(source.isClosed()).toBe(false);
    expect(source.state.status).toBe("running");
    await sleep(100);
    expect(executor.inputs).toHaveLength(1);
    executor.settleInterruptedTurn();
    await waitFor(
      () => executor.inputs.length === 2,
      "the queued notification turn after cancellation settled",
    );
    const nextTurn = JSON.stringify(executor.inputs[1]?.body);
    expect(nextTurn).toContain("queued before Esc");
    expect(nextTurn).not.toContain("Any pending monitors");
    source.socket.send("still watching after active Esc");
    await waitFor(
      () => executor.inputs.length === 3,
      "the Monitor event after active Esc",
    );
    expect(JSON.stringify(executor.inputs[2]?.body)).toContain(
      "still watching after active Esc",
    );
    expect(source.state.status).toBe("running");
  }, 15_000);

  test("typed prompt, Esc, then a notification that arrives after cancellation settled", async () => {
    const executor = new DelayedInterruptExecutor();
    const { stdin } = await renderTestApp(executor);
    await typePrompt(stdin, "start turn");
    await waitFor(() => executor.inputs.length === 1, "the typed initial turn");
    stdin.push("\u001b");
    await executor.abortObserved;
    executor.settleInterruptedTurn();
    await sleep(200);
    addToMessageQueue({
      kind: "task_notification",
      text: monitorNotification("arrived after Esc"),
    });
    await waitFor(
      () => executor.inputs.length === 2,
      "the notification turn after an already-settled Esc",
    );
    expect(JSON.stringify(executor.inputs[1]?.body)).toContain(
      "arrived after Esc",
    );
  }, 15_000);

  test.each(["Enter", "new message", "cron event"])(
    "Esc parks a user message; a notification still drains; %s resumes",
    async (resumeWith) => {
      const executor = new DelayedInterruptExecutor();
      const { stdin } = await renderTestApp(executor);
      await typePrompt(stdin, "start turn");
      await waitFor(
        () => executor.inputs.length === 1,
        "the typed initial turn",
      );
      addToMessageQueue({ kind: "user", text: "queued while busy" });
      addToMessageQueue(
        resumeWith === "cron event"
          ? { kind: "user", source: "cron", text: "scheduled event" }
          : {
              kind: "task_notification",
              text: monitorNotification("arrived during turn"),
            },
      );
      stdin.push("\u001b");
      await executor.abortObserved;
      executor.settleInterruptedTurn();
      await waitFor(
        () => executor.inputs.length === 2,
        "the notification turn after Esc",
      );
      const notificationTurn = JSON.stringify(executor.inputs[1]?.body);
      expect(notificationTurn).toContain(
        resumeWith === "cron event" ? "scheduled event" : "arrived during turn",
      );
      expect(notificationTurn).not.toContain("queued while busy");
      await sleep(300);
      expect(executor.inputs).toHaveLength(2);
      if (resumeWith !== "new message") {
        stdin.push("\r");
      } else {
        await typePrompt(stdin, "sent after interrupt");
      }
      await waitFor(
        () => executor.inputs.length === 3,
        "the parked message to run after resuming",
      );
      expect(JSON.stringify(executor.inputs[2]?.body)).toContain(
        "queued while busy",
      );
      if (resumeWith === "new message") {
        await waitFor(
          () =>
            JSON.stringify(executor.inputs.slice(2)).includes(
              "sent after interrupt",
            ),
          "the new message to reach the backend",
        );
        const resumed = JSON.stringify(executor.inputs.slice(2));
        expect(resumed.indexOf("queued while busy")).toBeLessThan(
          resumed.indexOf("sent after interrupt"),
        );
      }
    },
    20_000,
  );
});
