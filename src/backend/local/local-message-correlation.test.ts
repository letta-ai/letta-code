import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationMessageCreateBody,
  ConversationMessageListBody,
} from "@/backend";
import { LocalStore } from "@/backend/local/local-store";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-message-correlation-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("local user message correlation", () => {
  test("preserves the inbound otid through projection and transcript reload", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-correlation";
    const otid = "desktop-user-message-1";
    const clientMessageId = "transport-user-message-1";
    const store = new LocalStore(agentId, { storageDir });

    store.appendTurnInput("default", {
      agent_id: agentId,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          otid,
          client_message_id: clientMessageId,
        },
      ],
    } as unknown as ConversationMessageCreateBody);

    expect(store.listLocalMessages("default", agentId)).toEqual([
      expect.objectContaining({ role: "user", otid }),
    ]);
    expect(
      store.listConversationMessages("default", {
        agent_id: agentId,
        order: "asc",
      } as ConversationMessageListBody),
    ).toEqual([
      expect.objectContaining({ message_type: "user_message", otid }),
    ]);

    const reloaded = new LocalStore(agentId, { storageDir });
    expect(
      reloaded.listConversationMessages("default", {
        agent_id: agentId,
        order: "asc",
      } as ConversationMessageListBody),
    ).toEqual([
      expect.objectContaining({ message_type: "user_message", otid }),
    ]);
  });

  test("seeds the otid from client_message_id when otid is absent", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-client-correlation";
    const clientMessageId = "transport-user-message-2";
    const store = new LocalStore(agentId, { storageDir });

    store.appendTurnInput("default", {
      agent_id: agentId,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello from an older sender" }],
          client_message_id: clientMessageId,
        },
      ],
    } as unknown as ConversationMessageCreateBody);

    const reloaded = new LocalStore(agentId, { storageDir });
    expect(
      reloaded.listConversationMessages("default", {
        agent_id: agentId,
        order: "asc",
      } as ConversationMessageListBody),
    ).toEqual([
      expect.objectContaining({
        message_type: "user_message",
        otid: clientMessageId,
      }),
    ]);
  });
});
