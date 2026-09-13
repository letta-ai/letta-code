import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type WebSocket from "ws";
import { addTask, getTask } from "@/cron";
import { handleCronCommand } from "@/websocket/listener/commands/cron";
import type { SafeSocketSend } from "@/websocket/listener/commands/types";

const TEST_DIR = path.join(import.meta.dir, "__cron_command_test_tmp__");
const originalHome = process.env.LETTA_HOME;

let messages: unknown[];
const socket = {} as WebSocket;
const safeSocketSend: SafeSocketSend = (_socket, payload) => {
  messages.push(payload);
  return true;
};

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.LETTA_HOME = TEST_DIR;
  messages = [];
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (originalHome) process.env.LETTA_HOME = originalHome;
  else delete process.env.LETTA_HOME;
});

function addRecurringTask() {
  return addTask({
    agent_id: "agent-1",
    conversation_id: "conv-1",
    name: "Recurring task",
    description: "Runs repeatedly",
    cron: "*/5 * * * *",
    recurring: true,
    prompt: "Do the work",
  }).task;
}

describe("cron pause and resume commands", () => {
  test("pause and resume return the persisted task and emit crons_updated", async () => {
    const task = addRecurringTask();

    await handleCronCommand(
      {
        type: "cron_pause",
        request_id: "pause-1",
        task_id: task.id,
      },
      socket,
      safeSocketSend,
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "cron_pause_response",
        request_id: "pause-1",
        success: true,
        found: true,
        task: expect.objectContaining({ id: task.id, status: "paused" }),
      }),
      expect.objectContaining({
        type: "crons_updated",
        agent_id: "agent-1",
        conversation_id: "conv-1",
      }),
    ]);
    expect(getTask(task.id)?.status).toBe("paused");

    messages = [];
    await handleCronCommand(
      {
        type: "cron_update",
        request_id: "update-1",
        task_id: task.id,
        prompt: "Updated while paused",
      },
      socket,
      safeSocketSend,
    );
    expect(getTask(task.id)).toMatchObject({
      status: "paused",
      prompt: "Updated while paused",
    });

    messages = [];
    await handleCronCommand(
      {
        type: "cron_resume",
        request_id: "resume-1",
        task_id: task.id,
      },
      socket,
      safeSocketSend,
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: "cron_resume_response",
        request_id: "resume-1",
        success: true,
        found: true,
        task: expect.objectContaining({ id: task.id, status: "active" }),
      }),
      expect.objectContaining({
        type: "crons_updated",
        agent_id: "agent-1",
        conversation_id: "conv-1",
      }),
    ]);
  });

  test("overdue one-off resume is rejected until the command supplies a future time", async () => {
    const task = addTask({
      agent_id: "agent-1",
      conversation_id: "conv-1",
      name: "One-off task",
      description: "Runs once",
      cron: "0 0 * * *",
      recurring: false,
      prompt: "Do the work",
      scheduled_for: new Date("2020-01-01T00:00:00.000Z"),
    }).task;
    await handleCronCommand(
      { type: "cron_pause", request_id: "pause-1", task_id: task.id },
      socket,
      safeSocketSend,
    );

    messages = [];
    await handleCronCommand(
      { type: "cron_resume", request_id: "resume-1", task_id: task.id },
      socket,
      safeSocketSend,
    );
    expect(messages).toEqual([
      expect.objectContaining({
        type: "cron_resume_response",
        success: false,
        found: true,
        task: expect.objectContaining({ status: "paused" }),
        error: expect.stringContaining("new future scheduled_for"),
      }),
    ]);

    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    messages = [];
    await handleCronCommand(
      {
        type: "cron_resume",
        request_id: "resume-2",
        task_id: task.id,
        scheduled_for: future,
      },
      socket,
      safeSocketSend,
    );
    expect(messages[0]).toEqual(
      expect.objectContaining({
        type: "cron_resume_response",
        success: true,
        found: true,
        task: expect.objectContaining({
          status: "active",
          scheduled_for: future,
        }),
      }),
    );
  });
});
