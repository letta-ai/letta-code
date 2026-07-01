import { beforeEach, describe, expect, test } from "bun:test";
import {
  addToMessageQueue,
  clearPendingMessages,
  isQueueBridgeConnected,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import {
  extractTaskNotificationsForDisplay,
  formatTaskNotification,
  type TaskNotification,
} from "@/utils/task-notifications";

describe("taskNotifications", () => {
  describe("formatTaskNotification", () => {
    test("formats single notification correctly", () => {
      const notification: TaskNotification = {
        taskId: "task_1",
        status: "completed",
        summary: 'Agent "Find files" completed',
        result: "Found 5 files in src/",
        outputFile: "/tmp/task_1.log",
      };

      const formatted = formatTaskNotification(notification);

      expect(formatted).toContain("<task-notification>");
      expect(formatted).toContain("<task-id>task_1</task-id>");
      expect(formatted).toContain("<status>completed</status>");
      expect(formatted).toContain(
        '<summary>Agent "Find files" completed</summary>',
      );
      expect(formatted).toContain("<result>Found 5 files in src/</result>");
      expect(formatted).toContain("</task-notification>");
      expect(formatted).toContain(
        "Full transcript available at: /tmp/task_1.log",
      );
    });

    test("escapes XML special characters in summary", () => {
      const notification: TaskNotification = {
        taskId: "task_1",
        status: "completed",
        summary: 'Agent <script>alert("xss")</script> completed',
        result: "Normal result",
        outputFile: "/tmp/task_1.log",
      };

      const formatted = formatTaskNotification(notification);

      // Quotes don't need escaping in XML text content, only in attributes
      expect(formatted).toContain('&lt;script&gt;alert("xss")&lt;/script&gt;');
      expect(formatted).not.toContain("<script>");
    });

    test("escapes XML special characters in result", () => {
      const notification: TaskNotification = {
        taskId: "task_1",
        status: "completed",
        summary: "Agent completed",
        result: "Found items: <item1> & <item2>",
        outputFile: "/tmp/task_1.log",
      };

      const formatted = formatTaskNotification(notification);

      expect(formatted).toContain("&lt;item1&gt; &amp; &lt;item2&gt;");
      expect(formatted).not.toContain("<item1>");
    });

    test("handles multiline results", () => {
      const notification: TaskNotification = {
        taskId: "task_1",
        status: "completed",
        summary: 'Agent "Search" completed',
        result: "Line 1\nLine 2\nLine 3",
        outputFile: "/tmp/task_1.log",
      };

      const formatted = formatTaskNotification(notification);

      expect(formatted).toContain("<result>Line 1\nLine 2\nLine 3</result>");
    });

    test("handles failed status", () => {
      const notification: TaskNotification = {
        taskId: "task_1",
        status: "failed",
        summary: 'Agent "Test" failed',
        result: "Error: Something went wrong",
        outputFile: "/tmp/task_1.log",
      };

      const formatted = formatTaskNotification(notification);

      expect(formatted).toContain("<status>failed</status>");
    });

    test("includes usage when provided", () => {
      const notification: TaskNotification = {
        taskId: "task_1",
        status: "completed",
        summary: 'Agent "Test" completed',
        result: "Result",
        outputFile: "/tmp/task_1.log",
        usage: {
          totalTokens: 123,
          toolUses: 4,
          durationMs: 5678,
        },
      };

      const formatted = formatTaskNotification(notification);

      expect(formatted).toContain("<usage>");
      expect(formatted).toContain("total_tokens: 123");
      expect(formatted).toContain("tool_uses: 4");
      expect(formatted).toContain("duration_ms: 5678");
      expect(formatted).toContain("</usage>");
    });

    test("hides agent-only system reminder notifications from display", () => {
      const message = `<task-notification>
<summary>Memory reflection merge pending; resolving in parent agent.</summary>
<result>
<system-reminder>
ACTION REQUIRED: Resolve pending reflection memory merge.
</system-reminder>
</result>
</task-notification>`;

      expect(extractTaskNotificationsForDisplay(message)).toEqual({
        notifications: [],
        cleanedText: "",
      });
    });
  });
});

describe("messageQueueBridge", () => {
  // Reset the bridge before each test
  beforeEach(() => {
    setMessageQueueAdder(null);
    clearPendingMessages();
  });

  test("isQueueBridgeConnected returns false when not set", () => {
    expect(isQueueBridgeConnected()).toBe(false);
  });

  test("isQueueBridgeConnected returns true when set", () => {
    setMessageQueueAdder(() => {});
    expect(isQueueBridgeConnected()).toBe(true);
  });

  test("addToMessageQueue calls the adder when set", () => {
    const messages: QueuedMessage[] = [];
    setMessageQueueAdder((msg) => messages.push(msg));

    addToMessageQueue({ kind: "user", text: "test message 1" });
    addToMessageQueue({ kind: "user", text: "test message 2" });

    expect(messages).toEqual([
      { kind: "user", text: "test message 1" },
      { kind: "user", text: "test message 2" },
    ]);
  });

  test("addToMessageQueue does nothing when adder not set", () => {
    // Should not throw
    expect(() =>
      addToMessageQueue({ kind: "user", text: "test message" }),
    ).not.toThrow();
  });

  test("addToMessageQueue buffers until adder is set", () => {
    const messages: QueuedMessage[] = [];

    addToMessageQueue({ kind: "user", text: "early message" });
    setMessageQueueAdder((msg) => messages.push(msg));

    expect(messages).toEqual([{ kind: "user", text: "early message" }]);
  });

  test("setMessageQueueAdder can be cleared", () => {
    const messages: QueuedMessage[] = [];
    setMessageQueueAdder((msg) => messages.push(msg));

    addToMessageQueue({ kind: "user", text: "message 1" });
    setMessageQueueAdder(null);
    addToMessageQueue({ kind: "user", text: "message 2" }); // Should be dropped

    expect(messages).toEqual([{ kind: "user", text: "message 1" }]);
    expect(isQueueBridgeConnected()).toBe(false);
  });
});
