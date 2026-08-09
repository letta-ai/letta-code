import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bash } from "@/tools/impl/bash";
import { kill_bash } from "@/tools/impl/kill-bash";
import { backgroundProcesses } from "@/tools/impl/process_manager";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";

const isWindows = process.platform === "win32";

/**
 * Regression coverage for letta-ai/letta-code#3226.
 *
 * Bash.md promises the agent it will be notified when a `run_in_background`
 * command finishes, so a completed shell must reach the message queue the same
 * way a background subagent's completion does.
 *
 * Assertions match on the shell's own task id rather than on `queued[0]`: the
 * process registry and the queue bridge are module-level singletons, and a
 * shell torn down by a previous test can deliver its exit event here.
 */
describe.skipIf(isWindows)("Background bash completion notifications", () => {
  let queued: QueuedMessage[] = [];

  const startBackground = async (args: {
    command: string;
    description?: string;
    timeout?: number;
    parentScope?: { agentId: string; conversationId: string };
  }): Promise<string> => {
    const result = await bash({ ...args, run_in_background: true });
    const bashId = result.content[0]?.text.match(/bash_\d+/)?.[0];
    expect(bashId).toBeDefined();
    return bashId as string;
  };

  const notificationsFor = (bashId: string): QueuedMessage[] =>
    queued.filter((message) => message.text.includes(`<task-id>${bashId}<`));

  /** Wait for this shell's own notification, ignoring any strays. */
  const waitForNotification = async (
    bashId: string,
    timeoutMs = 5_000,
  ): Promise<QueuedMessage> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [match] = notificationsFor(bashId);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No task notification queued for ${bashId}`);
  };

  beforeEach(() => {
    queued = [];
    clearPendingMessages();
    setMessageQueueAdder((message) => {
      queued.push(message);
    });
  });

  afterEach(() => {
    setMessageQueueAdder(null);
    clearPendingMessages();
    for (const proc of backgroundProcesses.values()) {
      try {
        proc.process.kill("SIGTERM");
      } catch {
        // Ignore cleanup failures for already-exited processes
      }
    }
    backgroundProcesses.clear();
  });

  test("queues a task notification when a background command succeeds", async () => {
    const bashId = await startBackground({
      command: "echo 'deploy finished'",
      description: "Watch deploy",
      parentScope: { agentId: "agent-1", conversationId: "conv-1" },
    });

    const notification = await waitForNotification(bashId);

    expect(notification.kind).toBe("task_notification");
    expect(notification.agentId).toBe("agent-1");
    expect(notification.conversationId).toBe("conv-1");
    expect(notification.text).toContain("<status>completed</status>");
    expect(notification.text).toContain(
      'Background command "Watch deploy" completed',
    );
    expect(notification.text).toContain("deploy finished");
    expect(notification.text).toContain("Full transcript available at:");
  });

  test("reports a failing background command as failed with its exit code", async () => {
    const bashId = await startBackground({
      command: "echo 'boom' >&2; exit 3",
      description: "Failing job",
    });

    const notification = await waitForNotification(bashId);

    expect(notification.text).toContain("<status>failed</status>");
    expect(notification.text).toContain("Exit code: 3");
    expect(notification.text).toContain("boom");
  });

  test("falls back to the command when no description is given", async () => {
    const bashId = await startBackground({ command: "echo hi" });

    const notification = await waitForNotification(bashId);

    expect(notification.text).toContain(
      'Background command "echo hi" completed',
    );
  });

  test("notifies exactly once when a shell times out", async () => {
    const bashId = await startBackground({
      command: "sleep 5",
      description: "Slow job",
      timeout: 150,
    });

    const notification = await waitForNotification(bashId);
    expect(notification.text).toContain("<status>failed</status>");
    expect(notification.text).toContain("Command timed out after 150ms");

    // A timed-out shell is force-killed after its completion promise rejects;
    // that teardown must not queue a second wake-up.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(notificationsFor(bashId)).toHaveLength(1);
  });

  test("stays silent when the agent deliberately kills the shell", async () => {
    const bashId = await startBackground({
      command: "sleep 5",
      description: "Cancelled job",
    });

    expect((await kill_bash({ shell_id: bashId })).killed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(notificationsFor(bashId)).toHaveLength(0);
  });
});
