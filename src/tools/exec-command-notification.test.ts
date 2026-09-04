import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  __clearExecSessionsForTests,
  exec_command,
  write_stdin,
} from "@/tools/impl/exec-command";
import { backgroundProcesses } from "@/tools/impl/process_manager";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("Exec command completion notifications", () => {
  let queued: QueuedMessage[] = [];

  function notificationsFor(sessionId: string): QueuedMessage[] {
    return queued.filter((message) =>
      message.text.includes(`<task-id>exec_${sessionId}</task-id>`),
    );
  }

  async function waitForNotification(
    sessionId: string,
    timeoutMs = 5_000,
  ): Promise<QueuedMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [notification] = notificationsFor(sessionId);
      if (notification) return notification;
      await Bun.sleep(20);
    }
    throw new Error(`No exec notification queued for ${sessionId}`);
  }

  function sessionIdFrom(output: string): string {
    const sessionId = output.match(
      /Process running with session ID (\d+)/,
    )?.[1];
    expect(sessionId).toBeDefined();
    return sessionId as string;
  }

  beforeEach(() => {
    queued = [];
    clearPendingMessages();
    setMessageQueueAdder((message) => queued.push(message));
  });

  afterEach(() => {
    setMessageQueueAdder(null);
    clearPendingMessages();
    for (const processState of backgroundProcesses.values()) {
      try {
        processState.process.kill("SIGTERM");
      } catch {
        // The process may already have exited.
      }
      if (processState.outputFile && fs.existsSync(processState.outputFile)) {
        fs.rmSync(processState.outputFile, { recursive: true, force: true });
      }
    }
    backgroundProcesses.clear();
    __clearExecSessionsForTests();
  });

  test("notifies once when a yielded command succeeds", async () => {
    const first = await exec_command({
      cmd: "printf start; sleep 0.4; printf done",
      description: "Run slow check",
      yield_time_ms: 250,
      parentScope: { agentId: "agent-1", conversationId: "conv-1" },
    });
    const sessionId = sessionIdFrom(first.output);

    expect(first.output).toContain(
      "You will be notified when the process completes. Do not poll unless you need the output before continuing.",
    );
    const notification = await waitForNotification(sessionId);

    expect(notification.kind).toBe("task_notification");
    expect(notification.agentId).toBe("agent-1");
    expect(notification.conversationId).toBe("conv-1");
    expect(notification.text).toContain("<status>completed</status>");
    expect(notification.text).toContain(
      'Exec command "Run slow check" completed',
    );
    expect(notification.text).toContain(`Session ID: ${sessionId}`);
    expect(notification.text).toContain("Exit code: 0");
    expect(notification.text).toContain("done");
    expect(notification.text).toContain("Full transcript available at:");
    expect(notificationsFor(sessionId)).toHaveLength(1);
  });

  test("notifies when a yielded command fails", async () => {
    const first = await exec_command({
      cmd: "sleep 0.3; printf boom >&2; exit 7",
      description: "Run failing check",
      yield_time_ms: 250,
    });
    const sessionId = sessionIdFrom(first.output);
    const notification = await waitForNotification(sessionId);

    expect(notification.text).toContain("<status>failed</status>");
    expect(notification.text).toContain("Exit code: 7");
    expect(notification.text).toContain("boom");
  });

  test("does not notify for a command that finishes before yielding", async () => {
    const result = await exec_command({
      cmd: "printf done",
      description: "Run quick check",
      yield_time_ms: 250,
    });

    expect(result.output).toContain("Process exited with code 0");
    await Bun.sleep(100);
    expect(queued).toHaveLength(0);
  });

  test("write_stdin completion replaces the notification", async () => {
    const first = await exec_command({
      cmd: "sleep 0.4; printf done",
      description: "Wait for check",
      yield_time_ms: 250,
    });
    const sessionId = sessionIdFrom(first.output);

    const result = await write_stdin({
      session_id: sessionId,
      chars: "",
      yield_time_ms: 1_000,
    });
    expect(result.output).toContain("Process exited with code 0");
    expect(result.output).toContain("done");

    await Bun.sleep(100);
    expect(notificationsFor(sessionId)).toHaveLength(0);
  });

  test("scrubs secrets and bounds notification output", async () => {
    const secret = "notification-secret";
    const first = await exec_command({
      cmd: "sleep 0.3; node -e \"process.stdout.write((process.env.PASSWORD ?? '') + 'x'.repeat(50000))\"",
      description: "Print bounded output",
      yield_time_ms: 250,
      secretEnv: { PASSWORD: secret },
    });
    const sessionId = sessionIdFrom(first.output);
    const notification = await waitForNotification(sessionId);

    expect(notification.text).not.toContain(secret);
    expect(notification.text).toContain("PASSWORD=&lt;REDACTED&gt;");
    expect(notification.text.length).toBeLessThan(35_000);
  });
});
