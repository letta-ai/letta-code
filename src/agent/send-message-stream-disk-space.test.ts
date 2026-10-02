import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { MessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import { executeApprovalBatch } from "@/agent/approval-execution";
import { sendMessageStreamWithBackend } from "@/agent/message";
import type { Backend } from "@/backend";
import {
  beginDiskSpaceActivity,
  createDiskSpaceMonitor,
  DISK_MONITOR_MIN_CHECK_INTERVAL_MS,
  DISK_MONITOR_POLL_INTERVAL_MS,
  setDiskSpaceMonitorForTests,
} from "@/reminders/disk-space-monitor";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";

const GIB = 1024 ** 3;

/**
 * A subagent runs as a headless one-shot child: no queue consumer is attached,
 * and it never receives another user turn. These tests drive the shared
 * request and tool-batch boundaries that every loop (TUI, headless, listener)
 * goes through.
 */
function installFakeDisk() {
  const disk = { usedPercent: 50 };
  const clock = { nowMs: 5_000_000 };
  const timers: Array<() => void> = [];
  const monitor = createDiskSpaceMonitor({
    env: { LETTA_MANAGED_CLOUD_RUNTIME: "1" },
    now: () => clock.nowMs,
    getWorkingDirectory: () => "/sandbox/work",
    statfsFn: async () => {
      const blocks = (20 * GIB) / 4096;
      return {
        bsize: 4096,
        blocks,
        bavail: Math.floor(blocks * (1 - disk.usedPercent / 100)),
      };
    },
    setInterval: (fn) => timers.push(fn),
    clearInterval: (handle) => {
      timers.splice((handle as number) - 1, 1);
    },
  });
  setDiskSpaceMonitorForTests(monitor);
  return { disk, clock, monitor, timers };
}

function recordingBackend(recorded: MessageCreateParams[]): Backend {
  const stream = {
    async *[Symbol.asyncIterator]() {},
  } as unknown as Stream<LettaStreamingResponse>;
  return {
    createConversationMessageStream: async (
      _conversationId: string,
      body: MessageCreateParams,
    ) => {
      recorded.push(body);
      return stream;
    },
  } as unknown as Backend;
}

function reminderTexts(body: MessageCreateParams | undefined): string[] {
  const texts: string[] = [];
  for (const message of body?.messages ?? []) {
    if (!("content" in message)) continue;
    const content = message.content;
    if (typeof content === "string") {
      if (content.includes("DISK")) texts.push(content);
      continue;
    }
    for (const part of content ?? []) {
      if (part.type === "text" && part.text.includes("DISK")) {
        texts.push(part.text);
      }
    }
  }
  return texts;
}

beforeEach(() => {
  setMessageQueueAdder(null);
  clearPendingMessages();
});

afterEach(() => {
  setDiskSpaceMonitorForTests(null);
  setMessageQueueAdder(null);
  clearPendingMessages();
});

describe("low-disk warning delivery", () => {
  test("a subagent loop receives the warning between tool batches without a new user turn", async () => {
    const { disk, clock } = installFakeDisk();
    const recorded: MessageCreateParams[] = [];
    const backend = recordingBackend(recorded);
    const preparedToolContext =
      await prepareToolExecutionContextForSpecificTools([], {});
    const options = { skillSources: [], preparedToolContext };

    // Turn start: plenty of space.
    await sendMessageStreamWithBackend(
      backend,
      "conv-subagent",
      [{ role: "user", content: "npm install everything", otid: "u1" }],
      options,
    );
    expect(reminderTexts(recorded[0])).toEqual([]);

    // A tool batch (the long install) fills the shared disk.
    disk.usedPercent = 97;
    clock.nowMs += DISK_MONITOR_MIN_CHECK_INTERVAL_MS;
    const results = await executeApprovalBatch([
      {
        type: "approve",
        approval: {
          toolCallId: "call-install",
          toolName: "Bash",
          toolArgs: "{}",
        },
        precomputedResult: {
          toolReturn: "added 2000 packages",
          status: "success",
        },
      },
    ]);

    // The approval continuation is the next model request of the same turn.
    await sendMessageStreamWithBackend(
      backend,
      "conv-subagent",
      [{ type: "approval", approvals: results, otid: "a1" }],
      options,
    );
    const continuation = recorded[1];
    const reminders = reminderTexts(continuation);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain("<system-reminder>");
    expect(reminders[0]).toContain("97% full");
    expect(reminders[0]).toContain("Pause large installs and builds");
    // Tool results stay first; the reminder is a user-role message after them.
    const messages = continuation?.messages ?? [];
    expect(messages[0]).toMatchObject({ type: "approval" });
    expect(messages.at(-1)).toMatchObject({ role: "user" });

    // Delivered once: the next request in the episode carries no repeat.
    clock.nowMs += DISK_MONITOR_MIN_CHECK_INTERVAL_MS;
    await sendMessageStreamWithBackend(
      backend,
      "conv-subagent",
      [{ type: "approval", approvals: results, otid: "a2" }],
      options,
    );
    expect(reminderTexts(recorded[2])).toEqual([]);
  });

  test("an idle parent with a queue consumer gets a queued task notification instead", async () => {
    const { disk, clock, monitor, timers } = installFakeDisk();
    const queued: QueuedMessage[] = [];
    setMessageQueueAdder((message) => queued.push(message));
    const recorded: MessageCreateParams[] = [];
    const preparedToolContext =
      await prepareToolExecutionContextForSpecificTools([], {});

    await sendMessageStreamWithBackend(
      recordingBackend(recorded),
      "conv-parent",
      [{ role: "user", content: "spawn Nix in the background", otid: "u1" }],
      { agentId: "agent-parent", skillSources: [], preparedToolContext },
    );
    expect(queued).toEqual([]);

    // The parent turn is over; spawnSubagent holds the activity lease while
    // the background child fills the shared disk.
    const releaseSubagent = beginDiskSpaceActivity({
      agentId: "agent-parent",
      conversationId: "conv-parent",
    });
    await monitor.whenIdle();
    disk.usedPercent = 99;
    clock.nowMs += DISK_MONITOR_POLL_INTERVAL_MS;
    expect(timers).toHaveLength(1);
    for (const tick of timers) tick();
    await monitor.whenIdle();
    releaseSubagent();
    expect(timers).toHaveLength(0);

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "task_notification",
      agentId: "agent-parent",
      conversationId: "conv-parent",
    });
    expect(queued[0]?.text).toContain("99% full");
    expect(reminderTexts(recorded[0])).toEqual([]);
  });
});
