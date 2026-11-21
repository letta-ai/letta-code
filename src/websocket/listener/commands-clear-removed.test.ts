import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { handleExecuteCommand } from "./commands";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  loadDurableQueuedInputs,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import type { ConversationRuntime, ListenerRuntime } from "./types";

/**
 * Remote `/clear` used to create a conversation and then reassign
 * `runtime.conversationId` in place while `runtime.key` kept addressing the
 * old scope. The next accepted input was keyed in the durable ledger under the
 * stale `runtime.key` but carried a replay payload scoped to the new
 * conversation, so the whole `input-dispositions-v2.json` failed validation
 * ("Disposition replay payload identity is invalid") and every subsequent
 * read of the store threw.
 *
 * The command is gone. An old client that still sends it must get a plain
 * unsuccessful result and must not move any runtime or conversation state.
 */

const REMOVED_MESSAGE =
  "/clear was removed; use /new to start a fresh conversation.";

class CapturingSocket {
  readyState = 1;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

type ExecuteCommandResponse = {
  type: string;
  request_id?: string;
  success?: boolean;
  output?: string;
};

function executeCommandResponses(
  socket: CapturingSocket,
): ExecuteCommandResponse[] {
  return socket.sentPayloads
    .map((payload) => JSON.parse(payload) as ExecuteCommandResponse)
    .filter((message) => message.type === "execute_command_response");
}

/**
 * Record one accepted input through the production reserve/commit path, the
 * same way an inbound user message does.
 */
function recordAcceptedInput(
  runtime: ConversationRuntime,
  clientMessageId: string,
): boolean {
  const admission = reserveInputDisposition(
    runtime,
    ordinaryInputIdentity(clientMessageId),
  );
  if (admission.kind !== "reserved") {
    throw new Error(`expected a reservation, got ${admission.kind}`);
  }
  return commitInputDisposition(runtime, admission.reservation, "queued", {
    incoming: {
      type: "message",
      agentId: runtime.agentId,
      conversationId: runtime.conversationId,
      messages: [
        {
          role: "user",
          content: clientMessageId,
          client_message_id: clientMessageId,
        },
      ],
    },
  });
}

function setupDurableListener(storageDir: string): {
  listener: ListenerRuntime;
  runtime: ConversationRuntime;
} {
  // A working backend is installed on purpose: the refusal must hold because
  // the command is gone, not because conversation creation happened to fail.
  __testSetBackend(new FakeHeadlessBackend("agent-clear"));
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({
      persistentPath: join(storageDir, "input-dispositions-v2.json"),
    });
  setActiveRuntime(listener);
  const runtime = getOrCreateScopedRuntime(listener, "agent-clear", "default");
  return { listener, runtime };
}

describe("removed remote /clear command", () => {
  const storageDirs: string[] = [];

  afterEach(() => {
    setActiveRuntime(null);
    __testSetBackend(null);
    for (const dir of storageDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const commandId of ["clear", "clear-messages"] as const) {
    test(`/${commandId} is refused and leaves the ledger readable`, async () => {
      const storageDir = mkdtempSync(join(tmpdir(), "clear-removed-"));
      storageDirs.push(storageDir);
      const { listener, runtime } = setupDurableListener(storageDir);
      const conversationIdBefore = runtime.conversationId;
      const runtimeKeyBefore = runtime.key;
      const socket = new CapturingSocket();

      await handleExecuteCommand(
        {
          type: "execute_command",
          command_id: commandId,
          request_id: `${commandId}-removed-1`,
          runtime: {
            agent_id: "agent-clear",
            conversation_id: conversationIdBefore,
          },
        },
        socket as unknown as WebSocket,
        runtime,
        {},
      );

      expect(executeCommandResponses(socket)).toEqual([
        {
          type: "execute_command_response",
          request_id: `${commandId}-removed-1`,
          success: false,
          output: REMOVED_MESSAGE,
        },
      ]);

      // Conversation identity is untouched, so the ledger key and the replay
      // payload scope still agree on the next input.
      expect(runtime.conversationId).toBe(conversationIdBefore);
      expect(runtime.key).toBe(runtimeKeyBefore);

      expect(recordAcceptedInput(runtime, "message-after-clear")).toBe(true);

      const restored = loadDurableQueuedInputs(listener);
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({
        scope: {
          agentId: "agent-clear",
          conversationId: conversationIdBefore,
        },
        identity: { id: "message-after-clear" },
      });
    });
  }

  test("the removed command reports failure in the transcript too", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "clear-removed-"));
    storageDirs.push(storageDir);
    const { runtime } = setupDurableListener(storageDir);
    const socket = new CapturingSocket();

    await handleExecuteCommand(
      {
        type: "execute_command",
        command_id: "clear",
        request_id: "clear-removed-transcript",
        runtime: {
          agent_id: "agent-clear",
          conversation_id: runtime.conversationId,
        },
      },
      socket as unknown as WebSocket,
      runtime,
      {},
    );

    const transcript = socket.sentPayloads.join("\n");
    expect(transcript).toContain("slash_command_end");
    expect(transcript).toContain(REMOVED_MESSAGE);
  });
});
