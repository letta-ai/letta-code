import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { LocalBackend } from "@/backend/local/local-backend";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime, stopRuntime } from "@/websocket/listener/lifecycle";
import {
  getActiveRuntime,
  setActiveRuntime,
} from "@/websocket/listener/runtime";
import { createLocalSpawnerHandle } from "./local-spawner";

test("local Workflow workers preserve the invoking turn and report their conversation", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "letta-workflow-scope-"));
  const previousBackendMode = resolveBackendMode();
  const previousRuntime = getActiveRuntime();
  const runtime = createRuntime();
  let handle: Awaited<ReturnType<typeof createLocalSpawnerHandle>> | undefined;
  try {
    setConfiguredBackendMode("local");
    const backend = new LocalBackend({
      storageDir,
      memfsEnabled: false,
      executionMode: "deterministic",
    });
    __testSetBackend(backend);
    const parent = await backend.createAgent({
      name: "Parent",
      model: "openai/gpt-5.5",
    } as never);
    const parentRuntime = getOrCreateScopedRuntime(
      runtime,
      parent.id,
      "default",
    );
    const parentLease = parentRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: storageDir,
    });
    setActiveRuntime(runtime);

    handle = await createLocalSpawnerHandle({
      parentAgentId: parent.id,
      model: "openai/gpt-5.5",
      allowedTools: ["Read"],
      cwd: storageDir,
    });
    const started: string[] = [];
    const result = await handle.spawner(
      { prompt: "reply briefly", options: {}, callIndex: 0 },
      new AbortController().signal,
      { onStarted: (id) => started.push(id) },
    );
    expect(result.failed).toBe(false);
    const workerId = result.conversationId;
    if (!workerId) throw new Error("Missing persisted worker conversation");
    expect(started).toEqual([workerId]);
    const worker = await backend.retrieveConversation(workerId);
    expect(worker).toMatchObject({
      agent_id: null,
      parent_agent_id: parent.id,
    });
    expect(parentRuntime.turnLifecycle.currentLease).toBe(parentLease);
    expect(parentLease.signal.aborted).toBe(false);

    const continuation = await handle.spawner(
      {
        prompt: "continue",
        options: { conversationId: workerId },
        callIndex: 1,
      },
      new AbortController().signal,
    );
    expect(continuation).toMatchObject({
      failed: true,
      error: "Local Workflow worker continuation is not supported yet",
    });
    expect(parentRuntime.turnLifecycle.currentLease).toBe(parentLease);
    await handle.cleanup();
    handle = undefined;
    expect(parentRuntime.turnLifecycle.currentLease).toBe(parentLease);
    expect(getActiveRuntime()).toBe(runtime);
  } finally {
    await handle?.cleanup();
    stopRuntime(runtime, true);
    setActiveRuntime(previousRuntime);
    setConfiguredBackendMode(previousBackendMode);
    __testSetBackend(null);
    rmSync(storageDir, { recursive: true, force: true });
  }
});
