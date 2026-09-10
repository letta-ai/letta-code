import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __testSetBackend, type Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import * as taskModule from "@/tools/impl/task";
import { __listenClientTestUtils } from "./client";
import { handleExecuteCommand } from "./commands";

const priorHome = process.env.HOME;
let tempDir: string;
let spawn: ReturnType<
  typeof spyOn<typeof taskModule, "spawnBackgroundSubagentTask">
>;
afterEach(async () => {
  spawn?.mockRestore();
  __testSetBackend(null);
  await settingsManager.reset();
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test("listener doctor launches a scoped background investigation and returns without a foreground turn", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "listener-doctor-"));
  process.env.HOME = tempDir;
  await settingsManager.reset();
  await settingsManager.initialize();
  spawn = spyOn(taskModule, "spawnBackgroundSubagentTask");
  __testSetBackend({ capabilities: { localMemfs: false } } as Backend);
  spawn.mockReturnValue({
    taskId: "doctor-listener-task",
    subagentId: "investigator",
    outputFile: "/tmp/doctor-listener-report",
  });
  const listener = __listenClientTestUtils.createListenerRuntime();
  const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
    listener,
    "agent-doctor-listener",
    "conv-doctor-listener",
  );
  const sent: string[] = [];
  const socket = { readyState: 1, send: (value: string) => sent.push(value) };
  await handleExecuteCommand(
    {
      type: "execute_command",
      command_id: "doctor",
      args: "Repeated tool failures",
      request_id: "doctor-1",
      runtime: {
        agent_id: "agent-doctor-listener",
        conversation_id: "conv-doctor-listener",
        acting_user_id: "user-requester",
      },
    },
    socket as unknown as WebSocket,
    runtime,
    {},
  );
  expect(sent.join("\n")).toContain("doctor-listener-task");
  expect(spawn).toHaveBeenCalledTimes(1);
  const args = spawn.mock.calls[0]?.[0];
  expect(args?.parentScope).toEqual({
    agentId: "agent-doctor-listener",
    conversationId: "conv-doctor-listener",
  });
  expect(args?.actingUserId).toBe("user-requester");
  expect(args?.prompt).toContain("Repeated tool failures");
  expect(args?.existingAgentId).toBeUndefined();
  expect(runtime.isProcessing).toBe(false);
  expect(sent.join("\n")).toContain("doctor-listener-task");
  expect(sent.join("\n")).toContain("slash_command_end");
});
