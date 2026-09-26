import { describe, expect, test } from "bun:test";
import { autoBackgroundExternalTool } from "./external-tool-background";

const scope = {
  agentId: "agent-1",
  conversationId: "conv-1",
  actingUserId: "user-1",
};

describe("external tool auto-backgrounding", () => {
  test("keeps quick results inline without a notification", async () => {
    const notifications: unknown[] = [];
    const result = await autoBackgroundExternalTool(
      "lookup",
      undefined,
      Promise.resolve({ status: "success" as const, toolReturn: "found" }),
      {
        yieldMs: 10,
        runtimeScope: scope,
        enqueue: (message) => notifications.push(message),
      },
    );
    expect(result).toEqual({ status: "success", toolReturn: "found" });
    expect(notifications).toEqual([]);
  });

  test("yields one handle and notifies the original conversation on late success", async () => {
    let complete!: (result: { status: "success"; toolReturn: string }) => void;
    let calls = 0;
    const notifications: Array<{
      text: string;
      agentId?: string;
      conversationId?: string;
      actingUserId?: string;
    }> = [];
    const operation = new Promise<{ status: "success"; toolReturn: string }>(
      (resolve) => {
        calls += 1;
        complete = resolve;
      },
    );
    const result = await autoBackgroundExternalTool(
      "reply",
      undefined,
      operation,
      {
        yieldMs: 10,
        runtimeScope: scope,
        enqueue: (message) => notifications.push(message),
      },
    );
    expect(result.status).toBe("success");
    expect(result.toolReturn).toContain("external_");
    expect(calls).toBe(1);
    complete({ status: "success", toolReturn: '{"messageId":"123.45"}' });
    await Bun.sleep(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      agentId: "agent-1",
      conversationId: "conv-1",
      actingUserId: "user-1",
    });
    expect(notifications[0]?.text).toContain("messageId");
    expect(notifications[0]?.text).toContain("123.45");
    expect(notifications[0]?.text).not.toContain("Full transcript available");
  });

  test("waits inline when the caller has no agent scope to notify", async () => {
    const notifications: unknown[] = [];
    const result = await autoBackgroundExternalTool(
      "lookup",
      undefined,
      Bun.sleep(20).then(() => ({
        status: "success" as const,
        toolReturn: "private result",
      })),
      {
        yieldMs: 10,
        runtimeScope: { agentId: null, conversationId: "conv-1" },
        enqueue: (message) => notifications.push(message),
      },
    );
    expect(result.toolReturn).toBe("private result");
    expect(notifications).toEqual([]);
  });

  test("lets dependent tools opt out and return the actual result inline", async () => {
    const notifications: unknown[] = [];
    const result = await autoBackgroundExternalTool(
      "reply",
      { autoBackground: false },
      Bun.sleep(20).then(() => ({
        status: "success" as const,
        toolReturn: "posted",
      })),
      { yieldMs: 10, scope, enqueue: (message) => notifications.push(message) },
    );
    expect(result.toolReturn).toBe("posted");
    expect(notifications).toEqual([]);
  });

  test("returns an unknown-outcome failure in the completion notification", async () => {
    let fail!: (result: { status: "error"; toolReturn: string }) => void;
    const notifications: Array<{ text: string }> = [];
    const operation = new Promise<{ status: "error"; toolReturn: string }>(
      (resolve) => {
        fail = resolve;
      },
    );
    await autoBackgroundExternalTool("reply", undefined, operation, {
      yieldMs: 10,
      scope,
      enqueue: (message) => notifications.push(message),
    });
    fail({ status: "error", toolReturn: "Remote tool outcome is unknown" });
    await Bun.sleep(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.text).toContain("<status>failed</status>");
    expect(notifications[0]?.text).toContain("outcome is unknown");
  });
});
