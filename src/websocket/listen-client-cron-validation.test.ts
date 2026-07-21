import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { readCronFile } from "@/cron";
import { __listenClientTestUtils } from "@/websocket/listen-client";

class MockSocket {
  readyState: number;
  sentPayloads: string[] = [];

  constructor(readyState: number = WebSocket.OPEN) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

describe("listen-client cron validation", () => {
  test("rejects invalid cron add and update commands before persistence", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-listen-cron-"));
    const originalLettaHome = process.env.LETTA_HOME;
    process.env.LETTA_HOME = tempRoot;

    try {
      const socket = new MockSocket(WebSocket.OPEN);

      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_add",
          request_id: "cron-add-invalid",
          agent_id: "agent-1",
          conversation_id: "conv-1",
          name: "Invalid cron",
          description: "Should not persist",
          cron: "0 0 */32 * *",
          recurring: true,
          prompt: "do not run",
        },
        socket as unknown as WebSocket,
      );

      const invalidAdd = JSON.parse(socket.sentPayloads[0] as string);
      expect(invalidAdd).toMatchObject({
        type: "cron_add_response",
        request_id: "cron-add-invalid",
        success: false,
      });
      expect(invalidAdd.error).toContain(
        'Invalid cron expression "0 0 */32 * *"',
      );
      expect(readCronFile().tasks).toHaveLength(0);

      socket.sentPayloads.length = 0;
      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_add",
          request_id: "cron-add-valid",
          agent_id: "agent-1",
          conversation_id: "conv-1",
          name: "Valid cron",
          description: "Can persist",
          cron: "*/5 * * * *",
          recurring: true,
          prompt: "run",
        },
        socket as unknown as WebSocket,
      );
      const validAdd = JSON.parse(socket.sentPayloads[0] as string);
      expect(validAdd.success).toBe(true);
      const taskId = validAdd.task.id as string;

      socket.sentPayloads.length = 0;
      await __listenClientTestUtils.handleCronCommand(
        {
          type: "cron_update",
          request_id: "cron-update-invalid",
          task_id: taskId,
          cron: "0 0 */32 * *",
        },
        socket as unknown as WebSocket,
      );

      const invalidUpdate = JSON.parse(socket.sentPayloads[0] as string);
      expect(invalidUpdate).toMatchObject({
        type: "cron_update_response",
        request_id: "cron-update-invalid",
        success: false,
      });
      expect(invalidUpdate.error).toContain(
        'Invalid cron expression "0 0 */32 * *"',
      );
      expect(readCronFile().tasks).toEqual([
        expect.objectContaining({ id: taskId, cron: "*/5 * * * *" }),
      ]);
    } finally {
      if (originalLettaHome) {
        process.env.LETTA_HOME = originalLettaHome;
      } else {
        delete process.env.LETTA_HOME;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
