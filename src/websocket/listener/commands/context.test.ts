import { afterEach, describe, expect, test } from "bun:test";
import { __testSetBackend } from "@/backend";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { createChannelContextHandler } from "./context";

const originalConsoleError = console.error;
const originalLettaDebug = process.env.LETTA_DEBUG;

afterEach(() => {
  __testSetBackend(null);
  console.error = originalConsoleError;
  if (originalLettaDebug === undefined) {
    delete process.env.LETTA_DEBUG;
  } else {
    process.env.LETTA_DEBUG = originalLettaDebug;
  }
});

describe("channel context command handler", () => {
  test("/context reports load failures and debug-logs the cause", async () => {
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    process.env.LETTA_DEBUG = "1";
    __testSetBackend({
      retrieveAgent: async () => {
        throw new Error("backend unavailable");
      },
    } as never);

    const handler = createChannelContextHandler(createRuntime());
    const result = await handler({
      channelId: "telegram",
      runtime: {
        agent_id: "agent-1",
        conversation_id: "conv-1",
      },
    });

    expect(result.text).toBe(
      "Telegram could not load context usage right now. Try again in a moment.",
    );
    expect(JSON.stringify(logged)).toContain(
      "Failed to load channel context usage",
    );
    expect(JSON.stringify(logged)).toContain("backend unavailable");
  });
});
