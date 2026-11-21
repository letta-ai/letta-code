import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isExperimentalLocalBackendEnabled } from "@/backend/backend-mode";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";
import { renameSyncWithRetry } from "@/utils/rename-sync-with-retry";

export class OpenAiChatBindingError extends Error {}

function bindingIdentity(key: string) {
  const agentId = /^chat-key:([^:]+):.+$/.exec(key)?.[1];
  if (!agentId) throw new OpenAiChatBindingError("Invalid chat binding key");
  const digest = createHash("sha256").update(key).digest("hex");
  const directory = join(
    getLocalBackendStorageDir(),
    "openai-chat-bindings-v1",
  );
  return {
    agentId,
    digest,
    directory,
    path: join(directory, `${digest}.json`),
  };
}

/** Undefined means this backend uses the existing process-local mapping. */
export function readOpenAiChatBinding(key: string): string | null | undefined {
  if (!isExperimentalLocalBackendEnabled()) return undefined;
  const identity = bindingIdentity(key);
  let raw: string;
  try {
    raw = readFileSync(identity.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new OpenAiChatBindingError("Cannot read the saved chat binding", {
      cause: error,
    });
  }
  let record: Record<string, unknown> | undefined;
  try {
    record = JSON.parse(raw);
  } catch {
    // Invalid state must not fall through to creating an empty conversation.
  }
  if (
    !record ||
    record.version !== 1 ||
    record.key_sha256 !== identity.digest ||
    record.agent_id !== identity.agentId ||
    typeof record.conversation_id !== "string" ||
    !record.conversation_id ||
    record.conversation_id === "default"
  ) {
    throw new OpenAiChatBindingError("Invalid saved chat binding");
  }
  return record.conversation_id;
}

/** Commit the mapping before the caller submits any input to the conversation. */
export function writeOpenAiChatBinding(
  key: string,
  conversationId: string,
): void {
  if (!isExperimentalLocalBackendEnabled()) return;
  const identity = bindingIdentity(key);
  if (!conversationId || conversationId === "default") {
    throw new OpenAiChatBindingError("Invalid chat binding conversation");
  }
  if (readOpenAiChatBinding(key) === conversationId) return;
  const temporary = `${identity.path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(identity.directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      temporary,
      `${JSON.stringify({
        version: 1,
        key_sha256: identity.digest,
        agent_id: identity.agentId,
        conversation_id: conversationId,
      })}\n`,
      { flag: "wx", mode: 0o600, flush: true },
    );
    renameSyncWithRetry(temporary, identity.path);
    // Windows cannot open a directory for fsync; the file itself is flushed.
    if (process.platform !== "win32") {
      const descriptor = openSync(identity.directory, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  } catch (error) {
    throw new OpenAiChatBindingError("Cannot save the chat binding", {
      cause: error,
    });
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Successful rename already removed the temporary path. Preserve the
      // original write error if temporary-file cleanup also fails.
    }
  }
}
