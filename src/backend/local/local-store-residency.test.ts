import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessageCreateBody } from "@/backend";
import { LocalStore } from "@/backend/local/local-store";
import { LOCAL_STORE_RESIDENT_MESSAGE_LIMIT } from "@/backend/local/local-transcript";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-store-residency-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function userTurn(
  store: LocalStore,
  conversationId: string,
  agentId: string,
  text: string,
): void {
  store.appendTurnInput(conversationId, {
    agent_id: agentId,
    messages: [{ role: "user", content: text }],
  } as ConversationMessageCreateBody);
}

function seedMessages(
  store: LocalStore,
  conversationId: string,
  agentId: string,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    userTurn(store, conversationId, agentId, `message ${index}`);
  }
}

describe("LocalStore transcript residency", () => {
  test("keeps only a bounded tail resident when a session touches an existing conversation", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency";
    const seeded = new LocalStore(agentId, { storageDir });
    seedMessages(
      seeded,
      "default",
      agentId,
      3 * LOCAL_STORE_RESIDENT_MESSAGE_LIMIT,
    );

    // A new process/session over the same storage dir: the first message of
    // the session must not pin the whole transcript in memory.
    const store = new LocalStore(agentId, { storageDir });
    userTurn(store, "default", agentId, "first message of new session");

    expect(
      store.residentLocalMessageCountForTesting("default"),
    ).toBeLessThanOrEqual(LOCAL_STORE_RESIDENT_MESSAGE_LIMIT);
    // Paging from disk still serves the full in-context history.
    expect(store.listLocalMessages("default", agentId)).toHaveLength(
      3 * LOCAL_STORE_RESIDENT_MESSAGE_LIMIT + 1,
    );
  });

  test("bounds resident growth during a single long session", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-long";
    const store = new LocalStore(agentId, { storageDir });
    const total = 2 * LOCAL_STORE_RESIDENT_MESSAGE_LIMIT + 25;
    seedMessages(store, "default", agentId, total);

    expect(
      store.residentLocalMessageCountForTesting("default"),
    ).toBeLessThanOrEqual(LOCAL_STORE_RESIDENT_MESSAGE_LIMIT);
    expect(store.listLocalMessages("default", agentId)).toHaveLength(total);
  });

  test("serves descending pages across the resident window edge", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-pages";
    const seeded = new LocalStore(agentId, { storageDir });
    const total = 2 * LOCAL_STORE_RESIDENT_MESSAGE_LIMIT;
    seedMessages(seeded, "default", agentId, total);

    const store = new LocalStore(agentId, { storageDir });
    const pageSize = 40;
    const firstPage = store.listConversationMessages("default", {
      agent_id: agentId,
      order: "desc",
      limit: pageSize,
    } as never);
    expect(firstPage).toHaveLength(pageSize);

    const cursor = (firstPage[firstPage.length - 1] as { id: string }).id;
    const secondPage = store.listConversationMessages("default", {
      agent_id: agentId,
      order: "desc",
      limit: pageSize,
      before: cursor,
    } as never);
    expect(secondPage).toHaveLength(pageSize);
    const firstIds = new Set(firstPage.map((message) => message.id));
    for (const message of secondPage) {
      expect(firstIds.has(message.id)).toBe(false);
    }

    // Walk all the way back: every seeded message is reachable by paging.
    const seen = new Set<string>();
    let before: string | undefined;
    for (;;) {
      const page = store.listConversationMessages("default", {
        agent_id: agentId,
        order: "desc",
        limit: pageSize,
        ...(before ? { before } : {}),
      } as never);
      if (page.length === 0) break;
      for (const message of page) seen.add(message.id);
      before = (page[page.length - 1] as { id: string }).id;
      if (page.length < pageSize) break;
    }
    expect(seen.size).toBe(total);
  });

  test("drops compacted history from residency while keeping the transcript on disk", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-compaction";
    const store = new LocalStore(agentId, { storageDir });
    seedMessages(
      store,
      "default",
      agentId,
      2 * LOCAL_STORE_RESIDENT_MESSAGE_LIMIT,
    );
    const kept = store.listLocalMessages("default", agentId).slice(-10);
    store.compactConversationAll({
      conversationId: "default",
      agentId,
      summary: "summary of earlier work",
      packedSummary: "summary of earlier work",
      remainingMessages: kept,
    });

    const transcriptPath = join(
      storageDir,
      "conversations",
      Buffer.from(`default:${agentId}`).toString("base64url"),
      "messages.jsonl",
    );

    const fresh = new LocalStore(agentId, { storageDir });
    userTurn(fresh, "default", agentId, "after restart");

    // The active window (summary + 10 kept + 1 new) is tiny even though the
    // transcript file retains the full pre-compaction history.
    expect(
      fresh.residentLocalMessageCountForTesting("default"),
    ).toBeLessThanOrEqual(12);
    expect(fresh.listLocalMessages("default", agentId)).toHaveLength(12);
    const { readFileSync } = await import("node:fs");
    const transcript = readFileSync(transcriptPath, "utf8");
    expect(transcript.trim().split("\n").length).toBeGreaterThan(
      2 * LOCAL_STORE_RESIDENT_MESSAGE_LIMIT,
    );
  });

  test("in-memory stores retain full history", () => {
    const agentId = "agent-local-residency-memory";
    const store = new LocalStore(agentId);
    const total = LOCAL_STORE_RESIDENT_MESSAGE_LIMIT + 20;
    seedMessages(store, "default", agentId, total);
    expect(store.listLocalMessages("default", agentId)).toHaveLength(total);
  });

  test("dedup and projection indexes stay bounded as the window slides", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-residency-indexes";
    const store = new LocalStore(agentId, { storageDir });
    // A single long session: every append touches the dedup index, and
    // descending list calls index the sliding resident window's projections.
    const total = 3 * LOCAL_STORE_RESIDENT_MESSAGE_LIMIT;
    for (let index = 0; index < total; index += 1) {
      userTurn(store, "default", agentId, `message ${index}`);
      if (index % 10 === 0) {
        store.listConversationMessages("default", {
          agent_id: agentId,
          order: "desc",
          limit: 20,
        } as never);
      }
    }

    expect(
      store.residentLocalMessageCountForTesting("default"),
    ).toBeLessThanOrEqual(LOCAL_STORE_RESIDENT_MESSAGE_LIMIT);
    const indexes = store.transcriptIndexSizesForTesting("default");
    expect(indexes.persistedMessages).toBeLessThanOrEqual(
      LOCAL_STORE_RESIDENT_MESSAGE_LIMIT,
    );
    // Each resident message projects to a handful of lookup keys.
    expect(indexes.projectedMessages).toBeLessThanOrEqual(
      4 * LOCAL_STORE_RESIDENT_MESSAGE_LIMIT,
    );
    expect(store.listLocalMessages("default", agentId)).toHaveLength(total);
  });
});
