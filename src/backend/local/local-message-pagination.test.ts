import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { LocalStore } from "./local-store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(compacted: boolean) {
  const storageDir = await mkdtemp(join(tmpdir(), "local-pagination-"));
  directories.push(storageDir);
  const agentId = "agent-pagination";
  const writer = new LocalStore(agentId, {
    storageDir,
    residentMessageTailLimit: 4,
  });
  writer.appendTurnInput("default", {
    agent_id: agentId,
    messages: [{ role: "user", content: "earlier" }],
  });
  writer.appendStreamChunk("default", agentId, {
    message_type: "reasoning_message",
    reasoning: "thought",
  } as LettaStreamingResponse);
  writer.appendStreamChunk("default", agentId, {
    message_type: "assistant_message",
    content: [{ type: "text", text: "answer" }],
  } as LettaStreamingResponse);
  writer.appendStreamChunk("default", agentId, {
    message_type: "stop_reason",
    stop_reason: "end_turn",
  });
  const source = writer.listLocalMessages("default", agentId)[1];
  if (!source) throw new Error("Missing assistant source");
  for (let index = 0; index < 12; index++) {
    writer.appendTurnInput("default", {
      agent_id: agentId,
      messages: [{ role: "user", content: `${index}:${"x".repeat(8192)}` }],
    });
  }
  const all = writer.listConversationMessages("default", {
    agent_id: agentId,
    order: "asc",
  });
  if (compacted) {
    writer.compactConversationAll({
      conversationId: "default",
      agentId,
      summary: "summary",
      packedSummary: "summary",
      remainingMessages: writer.listLocalMessages("default", agentId).slice(-2),
    });
  }
  const reader = new LocalStore(agentId, {
    storageDir,
    residentMessageTailLimit: 4,
  });
  // Load the active window so it covers every in-context id after compaction.
  reader.listLocalMessages("default", agentId);
  return { reader, agentId, sourceId: source.id, all };
}

for (const compacted of [false, true]) {
  for (const direction of ["before", "after"] as const) {
    test(`${direction} reasoning-first source cursor ${compacted ? "outside" : "inside"} resident window`, async () => {
      const { reader, agentId, sourceId, all } = await fixture(compacted);
      const projections = all.filter((row) =>
        row.id.startsWith(`${sourceId}:`),
      );
      expect(projections.length).toBeGreaterThan(1);
      const first = all.findIndex((row) => row.id === projections[0]?.id);
      const last = all.findIndex((row) => row.id === projections.at(-1)?.id);
      const expected =
        direction === "before"
          ? all.slice(0, first).reverse()
          : all.slice(last + 1);
      const result = reader.listConversationMessages("default", {
        agent_id: agentId,
        [direction]: sourceId,
        order: direction === "before" ? "desc" : "asc",
        limit: 2,
      });
      expect(result.map((row) => row.id)).toEqual(
        expected.slice(0, 2).map((row) => row.id),
      );
    });
  }
}

for (const direction of ["before", "after"] as const) {
  test(`${direction} projected cursor outside resident window`, async () => {
    const { reader, agentId, all } = await fixture(true);
    const cursor = all[1];
    if (!cursor) throw new Error("Missing projected cursor");
    const expected =
      direction === "before" ? all.slice(0, 1).reverse() : all.slice(2);
    expect(
      reader
        .listConversationMessages("default", {
          agent_id: agentId,
          [direction]: cursor.id,
          order: direction === "before" ? "desc" : "asc",
          limit: 2,
        })
        .map((row) => row.id),
    ).toEqual(expected.slice(0, 2).map((row) => row.id));
  });
}

for (const direction of ["before", "after"] as const) {
  test(`${direction} unknown cursor returns an empty page`, async () => {
    const { reader, agentId } = await fixture(true);
    expect(
      reader.listConversationMessages("default", {
        agent_id: agentId,
        [direction]: "missing-message",
        order: direction === "before" ? "desc" : "asc",
        limit: 2,
      }),
    ).toEqual([]);
  });
}
