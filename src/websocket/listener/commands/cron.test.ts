import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { addTask, getTask, listTasks, updateTask } from "@/cron";
import { handleCronCommand } from "@/websocket/listener/commands/cron";
import type { SafeSocketSend } from "@/websocket/listener/commands/types";

describe("listener cron command validation", () => {
  let tempRoot: string;
  let originalLettaHome: string | undefined;
  let sent: unknown[];

  const socket = {} as WebSocket;
  const safeSocketSend: SafeSocketSend = (_socket, payload) => {
    sent.push(payload);
    return true;
  };

  beforeEach(() => {
    tempRoot = mkdtempSync(join(os.tmpdir(), "letta-cron-command-"));
    originalLettaHome = process.env.LETTA_HOME;
    process.env.LETTA_HOME = tempRoot;
    sent = [];
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    if (originalLettaHome === undefined) delete process.env.LETTA_HOME;
    else process.env.LETTA_HOME = originalLettaHome;
  });

  test("rejects an invalid cron before add persists it", async () => {
    await handleCronCommand(
      {
        type: "cron_add",
        request_id: "invalid-add",
        agent_id: "agent-1",
        name: "Invalid cron",
        description: "must not persist",
        cron: "0-60 * * * *",
        recurring: true,
        prompt: "do not run",
      },
      socket,
      safeSocketSend,
    );

    expect(sent).toEqual([
      expect.objectContaining({
        type: "cron_add_response",
        request_id: "invalid-add",
        success: false,
        error: 'Invalid cron expression "0-60 * * * *"',
      }),
    ]);
    expect(listTasks({ agent_id: "agent-1" })).toEqual([]);
  });

  test("rejects an invalid update without changing the stored task", async () => {
    await handleCronCommand(
      {
        type: "cron_add",
        request_id: "valid-add",
        agent_id: "agent-1",
        name: "Valid cron",
        description: "stays valid",
        cron: "*/5 * * * *",
        recurring: true,
        prompt: "run",
      },
      socket,
      safeSocketSend,
    );
    const taskId = (sent[0] as { task: { id: string } }).task.id;
    sent = [];

    await handleCronCommand(
      {
        type: "cron_update",
        request_id: "invalid-update",
        task_id: taskId,
        cron: "59-0 * * * *",
      },
      socket,
      safeSocketSend,
    );

    expect(sent).toEqual([
      expect.objectContaining({
        type: "cron_update_response",
        request_id: "invalid-update",
        success: false,
        error: 'Invalid cron expression "59-0 * * * *"',
      }),
    ]);
    expect(getTask(taskId)?.cron).toBe("*/5 * * * *");
  });

  test("clears a legacy invalid failure when the cron is corrected", async () => {
    const { task } = addTask({
      agent_id: "agent-1",
      name: "Legacy invalid cron",
      description: "created by an older client",
      cron: "0-60 * * * *",
      recurring: true,
      prompt: "run",
    });
    updateTask(task.id, (current) => {
      current.last_run_at = "2026-07-21T00:00:00.000Z";
      current.last_run_outcome = "failed";
      current.last_run_reason = "invalid_cron";
      current.last_run_error = "Invalid cron expression";
    });

    await handleCronCommand(
      {
        type: "cron_update",
        request_id: "correct-invalid",
        task_id: task.id,
        cron: "*/5 * * * *",
      },
      socket,
      safeSocketSend,
    );

    expect(sent[0]).toMatchObject({
      type: "cron_update_response",
      request_id: "correct-invalid",
      success: true,
    });
    expect(getTask(task.id)).toMatchObject({
      cron: "*/5 * * * *",
      last_run_at: null,
      last_run_outcome: null,
      last_run_reason: null,
      last_run_error: null,
    });
  });
});
