import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type { LocalMessage } from "./local-message";
import {
  createLocalTranscriptManifest,
  jsonl,
  localTranscriptSessionEntries,
  transcriptMessagesPath,
  writeLocalTranscriptManifest,
} from "./local-transcript";
import type { StoredConversation } from "./local-types";

export function listImportedLocalConversations(
  storageDir: string,
  agentId: string,
): StoredConversation[] {
  const root = join(storageDir, "conversations");
  if (!existsSync(root)) return [];
  const conversations: StoredConversation[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith(".pending")) continue;
    const file = join(root, entry.name, "conversation.json");
    if (!existsSync(file)) continue;
    const conversation = JSON.parse(
      readFileSync(file, "utf8"),
    ) as StoredConversation;
    if (conversation.id !== "default" && conversation.agent_id === agentId)
      conversations.push(conversation);
  }
  return conversations;
}

/** Write a complete v3 local transcript atomically, outside the live context.
 * A fresh store discovers this conversation on its next list/retrieve operation.
 */
export function writeImportedLocalConversation(
  storageDir: string,
  input: {
    agentId: string;
    summary: string;
    tags: string[];
    messages: LocalMessage[];
  },
): Conversation {
  if (input.messages.length === 0) {
    throw new Error("Cannot import an empty historical conversation");
  }
  const id = `local-conv-import-${randomUUID()}`;
  const now = new Date().toISOString();
  const messages = input.messages.map((message, index) => ({
    ...message,
    id: `${id}-message-${index}`,
    metadata: {
      ...message.metadata,
      agent_id: input.agentId,
      conversation_id: id,
    },
  })) as LocalMessage[];
  const conversation: StoredConversation = {
    id,
    agent_id: input.agentId,
    archived: false,
    archived_at: null,
    created_at: messages[0]?.metadata?.created_at ?? now,
    updated_at: messages.at(-1)?.metadata?.created_at ?? now,
    last_message_at: messages.at(-1)?.metadata?.created_at ?? now,
    summary: input.summary,
    tags: input.tags,
    in_context_message_ids: [],
  } as StoredConversation;
  const parent = join(storageDir, "conversations");
  mkdirSync(parent, { recursive: true });
  const target = join(
    parent,
    Buffer.from(`conversation:${id}`).toString("base64url"),
  );
  const staging = `${target}.pending`;
  mkdirSync(staging);
  try {
    writeFileSync(
      join(staging, "conversation.json"),
      `${JSON.stringify(conversation, null, 2)}\n`,
    );
    writeLocalTranscriptManifest(staging, createLocalTranscriptManifest());
    writeFileSync(
      transcriptMessagesPath(staging),
      jsonl(localTranscriptSessionEntries(conversation, messages)),
    );
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  // This import always supplies a concrete agentId; agent-free conversations
  // use the separate local workflow creation path.
  return conversation as Conversation;
}
