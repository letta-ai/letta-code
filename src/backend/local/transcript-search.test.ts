import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION,
  LOCAL_TRANSCRIPT_PROVIDER_STACK,
} from "@/backend/local/local-transcript";
import { searchLocalTranscriptMessages } from "@/backend/local/transcript-search";

// Issue #3580: an interrupted append must not hide earlier messages from search.

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function storageWithMessages(jsonl: string): Promise<string> {
  const storageDir = await mkdtemp(join(tmpdir(), "transcript-search-tail-"));
  directories.push(storageDir);
  const dir = join(storageDir, "conversations", "conv");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "conversation.json"),
    JSON.stringify({ id: "conv-1", agent_id: "agent-1" }),
  );
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      schema_version: LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION,
      message_format: LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
      provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
      created_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  await writeFile(join(dir, "messages.jsonl"), jsonl);
  return storageDir;
}

const needle = `${JSON.stringify({ id: "needle", role: "user", content: "needle", timestamp: 1 })}\n`;
const search = (storageDir: string) =>
  searchLocalTranscriptMessages(storageDir, { query: "needle" }).map(
    (result) => result.message_id,
  );

test("finds earlier messages when the last line was truncated", async () => {
  const storageDir = await storageWithMessages(`${needle}{"id":"unfinished"`);
  expect(search(storageDir)).toEqual(["needle"]);
});
