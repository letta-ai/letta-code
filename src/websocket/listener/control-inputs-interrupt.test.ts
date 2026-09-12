import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { bash } from "@/tools/impl/bash";
import { monitor } from "@/tools/impl/monitor";
import { MONITOR_EVENT_BATCH_MS } from "@/tools/impl/monitor-event-stream";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import { addToMessageQueue } from "@/utils/message-queue-bridge";
import { handleAbortMessageInput } from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import {
  clearProcessServices,
  installProcessEventRouting,
} from "./process-services";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { finishListenerTurn } from "./turn-terminal";
import type { IncomingMessage, StartListenerOptions } from "./types";

function requireFixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing interrupt test fixture");
  return value;
}

function createOpenTransport(): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener interrupt state");
}

describe("listener interrupt queue handoff", () => {
  afterEach(() => setActiveRuntime(null));

  test("abort stops earlier-turn monitor sources only in the exact runtime scope", async () => {
    const listener = createRuntime();
    const socket = createOpenTransport();
    const options = {} as StartListenerOptions;
    const scopes = [
      { agentId: "agent-monitor-a", conversationId: "shared" },
      { agentId: "agent-monitor-a", conversationId: "other" },
      { agentId: "agent-monitor-b", conversationId: "shared" },
    ];
    const runtimes = scopes.map((scope) =>
      getOrCreateScopedRuntime(listener, scope.agentId, scope.conversationId),
    );
    const target = requireFixture(runtimes[0]);
    const scratchpad = mkdtempSync(join(tmpdir(), "interrupt-monitors-"));
    const previousScratchpad = process.env.LETTA_SCRATCHPAD;
    process.env.LETTA_SCRATCHPAD = scratchpad;
    const taskIds: string[] = [];
    const peers: WebSocket[] = [];
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    server.on("connection", (peer) => peers.push(peer));
    const processQueuedTurn = mock(async (_incoming: IncomingMessage) => {});
    setActiveRuntime(listener);
    // Another test's background task can finish before this listener mounts.
    addToMessageQueue({
      kind: "task_notification",
      text: "Unrelated background task completed",
      agentId: "agent-unrelated-completion",
      conversationId: "unrelated-completion",
    });
    installProcessEventRouting({
      runtime: listener,
      processTransport: socket,
      opts: options,
      processQueuedTurn,
    });
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No WS port");
      // Start all sources in an earlier turn, not under the lease being aborted.
      const earlier = target.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
      });
      const script = join(scratchpad, "source.js");
      writeFileSync(
        script,
        "console.log(process.pid); setInterval(() => {}, 1000);",
      );
      const command = await monitor({
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        description: "target command",
        persistent: true,
        parentScope: scopes[0],
      });
      taskIds.push(command.taskId);
      for (const scope of scopes) {
        const result = await monitor({
          ws: { url: `ws://127.0.0.1:${address.port}` },
          description: `socket ${scope.agentId}/${scope.conversationId}`,
          persistent: true,
          parentScope: scope,
        });
        taskIds.push(result.taskId);
        await waitFor(() => peers.length === taskIds.length - 1, 4000);
      }
      const beforeBash = new Set(backgroundProcesses.keys());
      await bash({
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        description: "ordinary background task survives monitor cancellation",
        run_in_background: true,
        parentScope: scopes[0],
      });
      const bashId = requireFixture(
        [...backgroundProcesses.keys()].find((id) => !beforeBash.has(id)),
      );
      taskIds.push(bashId);
      const bashState = requireFixture(backgroundProcesses.get(bashId));
      await waitFor(() => (bashState.totalStdoutLines ?? 0) > 0, 4000);
      const bashPid = Number(
        readFileSync(requireFixture(bashState.outputFile), "utf8").trim(),
      );
      expect(bashPid).toBeGreaterThan(0);
      const commandState = requireFixture(
        backgroundProcesses.get(command.taskId),
      );
      await waitFor(() => (commandState.totalStdoutLines ?? 0) > 0, 4000);
      const pid = Number(
        readFileSync(requireFixture(commandState.outputFile), "utf8").trim(),
      );
      expect(pid).toBeGreaterThan(0);
      process.kill(pid, 0);
      await waitFor(() => target.queueRuntime.length > 0, 4000);
      finishListenerTurn(target, earlier, {
        stopReason: "end_turn",
        socket,
        agentId: requireFixture(scopes[0]).agentId,
        conversationId: requireFixture(scopes[0]).conversationId,
      });
      const later = target.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
      });
      target.turnLifecycle.setRunId(later, "run-later");
      // Keep the control scopes busy so their real routed notifications remain inspectable.
      for (const runtime of runtimes.slice(1)) {
        runtime.turnLifecycle.begin({
          origin: "message",
          workingDirectory: process.cwd(),
        });
      }
      const baseline = target.queueRuntime.peek().map((item) => item.id);
      requireFixture(peers[0]).send("buffered-before-cancel");
      const wsState = requireFixture(
        backgroundProcesses.get(requireFixture(taskIds[1])),
      );
      await waitFor(() => (wsState.totalStdoutLines ?? 0) > 0, 4000);
      // The frame reached the actual source but has not reached its batch timer.
      expect(target.queueRuntime.peek().map((item) => item.id)).toEqual(
        baseline,
      );
      const cancellation = createDeferred();
      expect(
        await handleAbortMessageInput(
          listener,
          {
            command: {
              type: "abort_message",
              runtime: {
                agent_id: requireFixture(scopes[0]).agentId,
                conversation_id: requireFixture(scopes[0]).conversationId,
              },
              run_id: "run-later",
            },
            socket,
            opts: options,
            processQueuedTurn,
          },
          {
            cancelRun: async () => cancellation.promise,
            cancelConversation: async () => {},
          },
        ),
      ).toBe(true);
      // Cancellation must stop local sources without waiting for the backend.
      expect(commandState.status).not.toBe("running");
      expect(wsState.status).not.toBe("running");
      await waitFor(() => requireFixture(peers[0]).readyState === 3, 4000);
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 4000);
      for (const peer of peers.slice(1))
        peer.send("still-delivering-after-cancel");
      await waitFor(
        () =>
          runtimes.slice(1).every((runtime) => runtime.queueRuntime.length > 0),
        4000,
      );
      await Bun.sleep(MONITOR_EVENT_BATCH_MS * 2);
      expect(target.queueRuntime.peek().map((item) => item.id)).toEqual(
        baseline,
      );
      for (const id of taskIds.slice(2))
        expect(backgroundProcesses.get(id)?.status).toBe("running");
      for (const runtime of runtimes.slice(1)) {
        expect(JSON.stringify(runtime.queueRuntime.peek())).toContain(
          "still-delivering-after-cancel",
        );
      }
      expect(bashState.status).toBe("running");
      process.kill(bashPid, 0);
      expect(
        processQueuedTurn.mock.calls.filter(([incoming]) =>
          scopes.some(
            (scope) =>
              incoming.agentId === scope.agentId &&
              incoming.conversationId === scope.conversationId,
          ),
        ),
      ).toEqual([]);
      cancellation.resolve();
    } finally {
      for (const id of taskIds) {
        const state = backgroundProcesses.get(id);
        if (state) {
          state.completionNotificationSuppressed = true;
          state.status = "failed";
          state.process.kill("SIGKILL");
          clearBackgroundProcessCleanup(id);
          backgroundProcesses.delete(id);
        }
      }
      for (const peer of peers) peer.terminate();
      server.close();
      clearProcessServices(listener);
      if (previousScratchpad === undefined) delete process.env.LETTA_SCRATCHPAD;
      else process.env.LETTA_SCRATCHPAD = previousScratchpad;
      rmSync(scratchpad, { recursive: true, force: true });
    }
  }, 15000);

  test("does not release the next turn before cancellation fallback settles", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = createOpenTransport();
    const options = {} as StartListenerOptions;
    const oldLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    runtime.turnLifecycle.setRunId(oldLease, "run-old");
    const cancellation = createDeferred();
    const cancelRun = mock(async (_agentId: string, _runId: string) => {
      throw new Error("run-scoped cancellation unavailable");
    });
    const cancelConversation = mock(
      async (_agentId: string, _conversationId: string) => cancellation.promise,
    );
    const processedTurns: IncomingMessage[] = [];
    const processQueuedTurn = mock(async (incoming: IncomingMessage) => {
      processedTurns.push(incoming);
    });
    setActiveRuntime(listener);

    expect(
      await handleAbortMessageInput(
        listener,
        {
          command: {
            type: "abort_message",
            runtime: {
              agent_id: "agent-1",
              conversation_id: "conv-1",
            },
            run_id: "run-old",
          },
          socket,
          opts: options,
          processQueuedTurn,
        },
        { cancelRun, cancelConversation },
      ),
    ).toBe(true);

    const queued = enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [{ role: "user", content: "kill the looping subagent" }],
    });
    expect(queued).toBe(true);
    scheduleQueuePump(runtime, socket, options, processQueuedTurn);

    expect(
      finishListenerTurn(runtime, oldLease, {
        stopReason: "cancelled",
        socket,
        runId: "run-old",
        agentId: "agent-1",
        conversationId: "conv-1",
      }).finished,
    ).toBe(true);

    await waitFor(
      () => !runtime.queuePumpActive && !runtime.queuePumpScheduled,
    );
    expect(runtime.turnLifecycle.kind).toBe("cancelling");
    expect(runtime.queueRuntime.length).toBe(1);
    expect(processedTurns).toEqual([]);
    expect(cancelRun).toHaveBeenCalledWith("agent-1", "run-old");
    expect(cancelConversation).toHaveBeenCalledWith("agent-1", "conv-1");

    cancellation.resolve();
    await waitFor(
      () =>
        runtime.turnLifecycle.kind === "idle" &&
        runtime.queueRuntime.length === 0 &&
        processedTurns.length === 1,
    );

    expect(processedTurns[0]?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "kill the looping subagent" }],
      },
    ]);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancelConversation).toHaveBeenCalledTimes(1);
    expect(processQueuedTurn).toHaveBeenCalledTimes(1);
  });
});
