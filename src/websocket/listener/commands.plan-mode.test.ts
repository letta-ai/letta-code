import { afterEach, describe, expect, test } from "bun:test";
import { settingsManager } from "@/settings-manager";
import { __testHandlePlanModeCommand } from "@/websocket/listener/commands";
import { __listenClientTestUtils } from "@/websocket/listen-client";

describe("listener plan-mode command", () => {
  afterEach(async () => {
    settingsManager.setPlanModeEnabled(false);
    await settingsManager.flush();
  });

  test("enables plan mode through the remote command handler", async () => {
    settingsManager.setPlanModeEnabled(false);
    await settingsManager.flush();

    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "default",
    );

    const result = await __testHandlePlanModeCommand(runtime, "on");

    expect(settingsManager.isPlanModeEnabled()).toBe(true);
    expect(result).toBe(
      "Plan mode enabled. /plan and plan-mode tools are now available.",
    );
  });

  test("returns usage text for invalid args", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "default",
    );

    const result = await __testHandlePlanModeCommand(runtime, "maybe");

    expect(result).toBe("Usage: /plan-mode on|off");
  });
});
