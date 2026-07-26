import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { settingsManager } from "@/settings-manager";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { getWorkingDirectoryScopeKey } from "@/websocket/listener/cwd";
import type { ListenerTransport } from "@/websocket/listener/transport";
import { createChannelCompactHandler } from "./channel-compact";

class MockSocket {
  readyState = WebSocket.OPEN;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

afterEach(() => {
  __testSetBackend(null);
});

describe("channel compact command handler", () => {
  test("returns usage feedback for invalid compact modes", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const socket = new MockSocket();
    const handler = createChannelCompactHandler(
      listener,
      socket as unknown as ListenerTransport,
    );

    const result = await handler({
      channelId: "telegram",
      runtime: { agent_id: "agent-1", conversation_id: "default" },
      args: "slide",
    });

    expect(result.text).toBe(
      'Invalid mode "slide". Run /compact help for usage.',
    );
  });

  test("runs manual compaction for the routed conversation", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "channel-compact-"));
    try {
      class CompactRecordingBackend extends LocalBackend {
        compactCalls: Parameters<
          LocalBackend["compactConversationMessages"]
        >[] = [];

        override async compactConversationMessages(
          ...args: Parameters<LocalBackend["compactConversationMessages"]>
        ): ReturnType<LocalBackend["compactConversationMessages"]> {
          this.compactCalls.push(args);
          return {
            num_messages_before: 7,
            num_messages_after: 2,
            summary: "compacted summary",
          } as Awaited<ReturnType<LocalBackend["compactConversationMessages"]>>;
        }
      }

      const backend = new CompactRecordingBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Channel Compact Agent",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const listener = __listenClientTestUtils.createListenerRuntime();
      const socket = new MockSocket();
      const handler = createChannelCompactHandler(
        listener,
        socket as unknown as ListenerTransport,
      );

      const result = await handler({
        channelId: "slack",
        runtime: { agent_id: agent.id, conversation_id: "default" },
        args: "sliding_window",
      });

      expect(result).toEqual({
        handled: true,
        text: "Compaction completed (mode: sliding_window). Message buffer length reduced from 7 to 2.\n\nSummary: compacted summary",
      });
      expect(backend.compactCalls).toHaveLength(1);
      expect(backend.compactCalls[0]?.[0]).toBe("default");
      expect(backend.compactCalls[0]?.[1]).toMatchObject({
        agent_id: agent.id,
        compaction_settings: {
          mode: "sliding_window",
        },
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("loads routed cwd PreCompact hooks and surfaces hook feedback", async () => {
    const baseDir = await mkdtemp(join(os.tmpdir(), "channel-compact-hooks-"));
    const fakeHome = join(baseDir, "home");
    const projectDir = join(baseDir, "project");
    const originalHome = process.env.HOME;
    let compactCalls = 0;
    try {
      await mkdir(join(projectDir, ".letta"), { recursive: true });
      await mkdir(fakeHome, { recursive: true });
      await writeFile(
        join(projectDir, ".letta", "settings.json"),
        JSON.stringify({
          hooks: {
            PreCompact: [
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command: "echo 'Cannot compact channel now' >&2 && exit 2",
                  },
                ],
              },
            ],
          },
        }),
      );
      await settingsManager.reset();
      process.env.HOME = fakeHome;
      await settingsManager.initialize();
      __testSetBackend({
        compactConversationMessages: async () => {
          compactCalls += 1;
          return {
            num_messages_before: 7,
            num_messages_after: 2,
            summary: "should not compact",
          };
        },
      } as never);
      const listener = __listenClientTestUtils.createListenerRuntime();
      listener.workingDirectoryByConversation.set(
        getWorkingDirectoryScopeKey("agent-1", "default"),
        projectDir,
      );
      const socket = new MockSocket();
      const handler = createChannelCompactHandler(
        listener,
        socket as unknown as ListenerTransport,
      );

      const result = await handler({
        channelId: "telegram",
        runtime: { agent_id: "agent-1", conversation_id: "default" },
      });

      expect(result.handled).toBe(true);
      expect(result.text).toStartWith("Compact blocked:");
      expect(result.text).toContain("Cannot compact channel now");
      expect(compactCalls).toBe(0);
    } finally {
      await settingsManager.reset();
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("does not leak compaction error details to the channel", async () => {
    const storageDir = await mkdtemp(
      join(os.tmpdir(), "channel-compact-failure-"),
    );
    const originalConsoleError = console.error;
    const originalLettaDebug = process.env.LETTA_DEBUG;
    const logged: unknown[][] = [];
    try {
      class FailingCompactBackend extends LocalBackend {
        override async compactConversationMessages(): ReturnType<
          LocalBackend["compactConversationMessages"]
        > {
          throw new Error("provider token secret-token");
        }
      }

      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      process.env.LETTA_DEBUG = "1";
      const backend = new FailingCompactBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Channel Compact Agent",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const listener = __listenClientTestUtils.createListenerRuntime();
      const socket = new MockSocket();
      const handler = createChannelCompactHandler(
        listener,
        socket as unknown as ListenerTransport,
      );

      const result = await handler({
        channelId: "telegram",
        runtime: { agent_id: agent.id, conversation_id: "default" },
      });

      expect(result.text).toBe(
        "Telegram could not compact this conversation right now. Try again in a moment.",
      );
      expect(result.text).not.toContain("secret-token");
      expect(JSON.stringify(logged)).toContain("secret-token");
    } finally {
      console.error = originalConsoleError;
      if (originalLettaDebug === undefined) {
        delete process.env.LETTA_DEBUG;
      } else {
        process.env.LETTA_DEBUG = originalLettaDebug;
      }
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
