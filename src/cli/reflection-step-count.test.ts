import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  createBuffers,
  type Line,
  markCurrentLineAsFinished,
  onChunk,
  toLines,
} from "@/cli/helpers/accumulator";
import {
  appendExternalTranscriptEntries,
  appendTranscriptDeltaJsonl,
  buildAutoReflectionPayload,
  finalizeAutoReflectionPayload,
  getReflectionTranscriptPaths,
  getReflectionTranscriptState,
  REFLECTION_STATE_SCHEMA_VERSION,
} from "@/cli/helpers/reflection-transcript";

const agentId = "agent-step-count";
const conversationId = "conversation-step-count";

function assistant(
  id: string,
  text: string,
  messageId?: string,
): Extract<Line, { kind: "assistant" }> {
  return {
    kind: "assistant",
    id,
    text,
    phase: "finished",
    messageId,
  };
}

describe("reflection canonical assistant steps", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "letta-reflection-steps-"));
    process.env.LETTA_TRANSCRIPT_ROOT = testRoot;
  });

  afterEach(async () => {
    delete process.env.LETTA_TRANSCRIPT_ROOT;
    await rm(testRoot, { recursive: true, force: true });
  });

  test("assistant display rows split by the real accumulator count as one step", async () => {
    const buffers = createBuffers();
    buffers.tokenStreamingEnabled = true;
    onChunk(buffers, {
      message_type: "assistant_message",
      id: "message-a1",
      otid: "assistant-otid-a1",
      content: `${"A".repeat(1500)}\n\nSecond paragraph`,
    } as LettaStreamingResponse);
    markCurrentLineAsFinished(buffers);
    const lines = toLines(buffers);
    const assistantLines = lines.filter((line) => line.kind === "assistant");
    expect(assistantLines).toHaveLength(2);
    expect(assistantLines.map((line) => line.messageId)).toEqual([
      "message-a1",
      "message-a1",
    ]);

    await appendTranscriptDeltaJsonl(agentId, conversationId, lines);

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(1);
    expect(state.steps_since_last_successful_reflection).toBe(1);
  });

  test("external ingestion filters repeated source ids before incrementing state", async () => {
    const entries = [
      {
        kind: "assistant" as const,
        text: "external answer",
        source_message_id: "external-a1",
      },
    ];
    expect(
      await appendExternalTranscriptEntries(agentId, conversationId, entries),
    ).toEqual({ appended: 1, skipped: 0 });
    expect(
      await appendExternalTranscriptEntries(agentId, conversationId, entries),
    ).toEqual({ appended: 0, skipped: 1 });

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(1);
  });

  test("assistant rows with distinct canonical message ids count separately", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      assistant("a1", "first", "message-a1"),
      assistant("a2", "second", "message-a2"),
    ]);

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(2);
  });

  test("assistant rows without canonical message ids retain one-row-per-step fallback", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      assistant("local-a1", "first"),
    ]);
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      assistant("local-a2", "second"),
    ]);

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(2);
  });

  test("v3 state migrates canonical counts from the transcript and duplicate anchor", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "first", messageId: "message-u1" },
      assistant("a1-split-0", "first fragment", "message-a1"),
      assistant("a1", "second fragment", "message-a1"),
      { kind: "user", id: "u2", text: "second", messageId: "message-u2" },
      assistant("a2", "second answer", "message-a2"),
    ]);
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await writeFile(
      paths.statePath,
      `${JSON.stringify({
        schema_version: "v3_assistant_steps",
        reflected_through_message_id: "message-a1",
        total_completed_steps: 3,
        reflected_completed_steps: 1,
        steps_since_last_successful_reflection: 2,
      })}\n`,
      "utf-8",
    );

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state).toMatchObject({
      schema_version: REFLECTION_STATE_SCHEMA_VERSION,
      reflected_through_message_id: "message-a1",
      total_completed_steps: 2,
      reflected_completed_steps: 1,
      steps_since_last_successful_reflection: 1,
    });
  });

  test("migration clears a missing anchor before its id appears again", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "old prompt", messageId: "message-u1" },
      assistant("a1", "old unreflected answer", "message-a1"),
    ]);
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await writeFile(
      paths.statePath,
      `${JSON.stringify({
        schema_version: "v3_assistant_steps",
        reflected_through_message_id: "message-missing",
        total_completed_steps: 1,
        reflected_completed_steps: 1,
        steps_since_last_successful_reflection: 0,
      })}\n`,
      "utf-8",
    );

    const migrated = await getReflectionTranscriptState(
      agentId,
      conversationId,
    );
    expect(migrated.reflected_through_message_id).toBeUndefined();
    expect(migrated.reflected_completed_steps).toBe(0);

    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      {
        kind: "user",
        id: "u2",
        text: "new prompt",
        messageId: "message-missing",
      },
      assistant("a2", "new answer", "message-a2"),
    ]);
    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;
    const payloadText = await readFile(payload.payloadPath, "utf-8");
    expect(payloadText).toContain("old unreflected answer");
    expect(payloadText).toContain("new answer");
  });

  test("a reflected anchor advances through every row sharing its canonical id", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "prompt", messageId: "message-u1" },
      assistant("a1-split-0", "first fragment", "message-a1"),
      assistant("a1", "second fragment", "message-a1"),
    ]);

    const firstPayload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(firstPayload).not.toBeNull();
    if (!firstPayload) return;
    const firstMessages = JSON.parse(
      await readFile(firstPayload.payloadPath, "utf-8"),
    ) as Array<{ role: string; content?: string }>;
    expect(
      firstMessages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual(["first fragment", "second fragment"]);

    await finalizeAutoReflectionPayload(
      agentId,
      conversationId,
      firstPayload.payloadPath,
      firstPayload.endSnapshotLine,
      true,
    );
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u2", text: "next", messageId: "message-u2" },
      assistant("a2", "next answer", "message-a2"),
    ]);

    const nextPayload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(nextPayload).not.toBeNull();
    expect(nextPayload?.startMessageId).toBe("message-u2");
    if (!nextPayload) return;
    const nextPayloadText = await readFile(nextPayload.payloadPath, "utf-8");
    expect(nextPayloadText).not.toContain("second fragment");
  });

  test("new split-row deltas after migration preserve canonical deduplication", async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await mkdir(paths.rootDir, { recursive: true });
    await writeFile(
      paths.transcriptPath,
      `${JSON.stringify({
        kind: "assistant",
        text: "first fragment",
        captured_at: new Date().toISOString(),
        source_line_id: "a1-split-0",
        source_message_id: "message-a1",
      })}\n`,
      "utf-8",
    );
    await writeFile(
      paths.statePath,
      `${JSON.stringify({
        schema_version: "v3_assistant_steps",
        total_completed_steps: 1,
        reflected_completed_steps: 0,
        steps_since_last_successful_reflection: 1,
      })}\n`,
      "utf-8",
    );

    await getReflectionTranscriptState(agentId, conversationId);
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      assistant("a2-split-0", "first fragment", "message-a2"),
      assistant("a2", "second fragment", "message-a2"),
    ]);
    let state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(2);

    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      assistant("a3", "new answer", "message-a3"),
    ]);
    state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(3);
  });
});
