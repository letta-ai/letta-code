import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __testSetBackend, type Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { __listenClientTestUtils } from "./client";
import { handleExecuteCommand } from "./commands";
import * as turnModule from "./turn";

const priorHome = process.env.HOME;
let tempDir: string;
let turn: ReturnType<typeof spyOn<typeof turnModule, "handleIncomingMessage">>;
afterEach(async () => {
  turn?.mockRestore();
  __testSetBackend(null);
  await settingsManager.reset();
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test.each([false, true])(
  "listener doctor awaits a primary turn in the investigation conversation (local=%s)",
  async (localMemfs) => {
    tempDir = mkdtempSync(join(tmpdir(), "listener-doctor-"));
    process.env.HOME = tempDir;
    await settingsManager.reset();
    await settingsManager.initialize();
    __testSetBackend({ capabilities: { localMemfs } } as Backend);
    let finishTurn!: () => void;
    const pendingTurn = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    turn = spyOn(turnModule, "handleIncomingMessage").mockReturnValue(
      pendingTurn,
    );
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-doctor-listener",
      "conv-doctor-listener",
    );
    const sent: string[] = [];
    const socket = { readyState: 1, send: (value: string) => sent.push(value) };
    const running = handleExecuteCommand(
      {
        type: "execute_command",
        command_id: "doctor",
        args: "Investigate repeated tool failures in conv-incident",
        request_id: "doctor-1",
        runtime: {
          agent_id: "agent-doctor-listener",
          conversation_id: "conv-doctor-listener",
          acting_user_id: "user-requester",
        },
      },
      socket as unknown as WebSocket,
      runtime,
      { connectionId: "connection-doctor" },
    );
    try {
      expect(turn).toHaveBeenCalledTimes(1);
      const incoming = turn.mock.calls[0]?.[0];
      expect(incoming).toMatchObject({
        agentId: "agent-doctor-listener",
        conversationId: "conv-doctor-listener",
        actingUserId: "user-requester",
      });
      expect(JSON.stringify(incoming?.messages)).toContain("conv-incident");
      expect(JSON.stringify(incoming?.messages)).toContain("context-doctor");
      expect(turn.mock.calls[0]?.[2]).toBe(runtime);
      expect(turn.mock.calls[0]?.[4]).toBe("connection-doctor");
      expect(sent.join("\n")).toContain("slash_command_start");
      expect(sent.join("\n")).not.toContain("slash_command_end");
    } finally {
      finishTurn();
      await running;
    }
    expect(sent.join("\n")).toContain("slash_command_end");
    expect(JSON.parse(sent[sent.length - 1] ?? "")).toMatchObject({
      success: true,
      output: "",
    });
  },
);
