import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  estimateStartupContextTokens,
  REFLECTION_PARENT_MEMORY_SNAPSHOT_CHAR_LIMIT,
  REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT,
} from "@/agent/subagents/context-budget";
import {
  appendTranscriptDeltaJsonl,
  buildAutoReflectionPayload,
  buildMultiReflectionPayload,
  buildParentMemorySnapshot,
  buildReflectionSelectorPrompt,
  buildReflectionSubagentPrompt,
  filterSystemPromptForReflection,
  finalizeAutoReflectionPayload,
  finalizeMultiReflectionPayload,
  getReflectionTranscriptPaths,
  getReflectionTranscriptState,
  listReflectionTranscriptCandidates,
  REFLECTION_STATE_SCHEMA_VERSION,
  readReflectionAutoSelection,
  recordMetaReflectionResult,
  recordSuccessfulReflectionForMetaTrigger,
} from "@/cli/helpers/reflection-transcript";
import { DIRECTORY_LIMIT_ENV } from "@/utils/directory-limits";

const DIRECTORY_LIMIT_ENV_KEYS = Object.values(DIRECTORY_LIMIT_ENV);
const ORIGINAL_DIRECTORY_ENV = Object.fromEntries(
  DIRECTORY_LIMIT_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;

function restoreDirectoryLimitEnv(): void {
  for (const key of DIRECTORY_LIMIT_ENV_KEYS) {
    const original = ORIGINAL_DIRECTORY_ENV[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

describe("reflectionTranscript helper", () => {
  const agentId = "agent-test";
  const conversationId = "conv-test";
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "letta-transcript-test-"));
    process.env.LETTA_TRANSCRIPT_ROOT = testRoot;
  });

  afterEach(async () => {
    restoreDirectoryLimitEnv();
    delete process.env.LETTA_TRANSCRIPT_ROOT;
    await rm(testRoot, { recursive: true, force: true });
  });

  test("auto payload advances message-id state on success", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "hello", messageId: "u1" },
      {
        kind: "assistant",
        id: "a1",
        text: "hi there",
        phase: "finished",
        messageId: "a1",
      },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;
    expect(payload.startMessageId).toBe("u1");
    expect(payload.endMessageId).toBe("a1");

    expect(payload.payloadPath.endsWith(".json")).toBe(true);
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    expect(payload.payloadPath.startsWith(paths.rootDir)).toBe(true);
    expect(dirname(payload.payloadPath)).toBe(paths.rootDir);

    const payloadText = await readFile(payload.payloadPath, "utf-8");
    const messages = JSON.parse(payloadText);
    expect(messages).toBeArray();
    expect(messages).toContainEqual({ role: "user", content: "hello" });
    expect(messages).toContainEqual({ role: "assistant", content: "hi there" });

    await finalizeAutoReflectionPayload(
      agentId,
      conversationId,
      payload.payloadPath,
      payload.endSnapshotLine,
      true,
    );

    expect(existsSync(payload.payloadPath)).toBe(true);

    const stateRaw = await readFile(paths.statePath, "utf-8");
    const state = JSON.parse(stateRaw) as {
      schema_version: string;
      reflected_through_message_id?: string;
      total_completed_steps: number;
      reflected_completed_steps: number;
      steps_since_last_successful_reflection: number;
    };
    expect(state.schema_version).toBe(REFLECTION_STATE_SCHEMA_VERSION);
    expect(state.reflected_through_message_id).toBe("a1");
    expect(state.total_completed_steps).toBe(1);
    expect(state.reflected_completed_steps).toBe(1);
    expect(state.steps_since_last_successful_reflection).toBe(0);

    const secondPayload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(secondPayload).toBeNull();
  });

  test("auto payload keeps message-id state on failure", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "remember this", messageId: "u1" },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;
    expect(payload.startMessageId).toBe("u1");
    expect(payload.endMessageId).toBe("u1");

    await finalizeAutoReflectionPayload(
      agentId,
      conversationId,
      payload.payloadPath,
      payload.endSnapshotLine,
      false,
    );

    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    const stateRaw = await readFile(paths.statePath, "utf-8");
    const state = JSON.parse(stateRaw) as {
      reflected_through_message_id?: string;
      reflected_completed_steps: number;
      steps_since_last_successful_reflection: number;
    };
    expect(state.reflected_through_message_id).toBeUndefined();
    expect(state.reflected_completed_steps).toBe(0);
    expect(state.steps_since_last_successful_reflection).toBe(0);

    const retried = await buildAutoReflectionPayload(agentId, conversationId);
    expect(retried).not.toBeNull();
  });

  test("v2 message-id state migrates from turn counts to assistant step counts", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "first", messageId: "u1" },
      {
        kind: "assistant",
        id: "a1",
        text: "first done",
        phase: "finished",
        messageId: "a1",
      },
      { kind: "user", id: "u2", text: "second", messageId: "u2" },
      {
        kind: "assistant",
        id: "a2",
        text: "second done",
        phase: "finished",
        messageId: "a2",
      },
    ]);

    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await writeFile(
      paths.statePath,
      `${JSON.stringify({
        schema_version: "v2_message_id",
        reflected_through_message_id: "a1",
        total_completed_turns: 2,
        reflected_completed_turns: 1,
        turns_since_last_successful_reflection: 1,
      })}\n`,
      "utf-8",
    );

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.schema_version).toBe(REFLECTION_STATE_SCHEMA_VERSION);
    expect(state.reflected_through_message_id).toBe("a1");
    expect(state.total_completed_steps).toBe(2);
    expect(state.reflected_completed_steps).toBe(1);
    expect(state.steps_since_last_successful_reflection).toBe(1);
  });

  test("auto payload uses actual message ids instead of transcript line ids", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      {
        kind: "user",
        id: "user-local-1",
        text: "hello",
        messageId: "message-user-1",
        otid: "otid-user-1",
      },
      {
        kind: "reasoning",
        id: "reasoning:message-assistant-1",
        text: "thinking",
        phase: "finished",
        messageId: "message-assistant-1",
      },
      {
        kind: "tool_call",
        id: "tool-call-1",
        toolCallId: "tool-call-1",
        name: "Read",
        argsText: "{}",
        resultText: "done",
        resultOk: true,
        phase: "finished",
      },
      {
        kind: "assistant",
        id: "assistant:message-assistant-1",
        text: "answer",
        phase: "finished",
        messageId: "message-assistant-1",
      },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;

    expect(payload.startMessageId).toBe("message-user-1");
    expect(payload.endMessageId).toBe("message-assistant-1");
  });

  test("auto payload ignores transcript rows without canonical message ids", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "local-user", text: "no backend id yet" },
      {
        kind: "assistant",
        id: "local-assistant",
        text: "no backend id either",
        phase: "finished",
      },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).toBeNull();

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(1);
    expect(state.reflected_completed_steps).toBe(0);
    expect(state.steps_since_last_successful_reflection).toBe(1);
  });

  test("auto payload includes noncanonical rows before the next canonical anchor", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "local-user", text: "live user row" },
      {
        kind: "assistant",
        id: "assistant:message-assistant-1",
        text: "live assistant row",
        phase: "finished",
        messageId: "message-assistant-1",
      },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;
    expect(payload.startMessageId).toBe("message-assistant-1");
    expect(payload.endMessageId).toBe("message-assistant-1");

    const payloadText = await readFile(payload.payloadPath, "utf-8");
    const messages = JSON.parse(payloadText);
    expect(messages).toContainEqual({ role: "user", content: "live user row" });
    expect(messages).toContainEqual({
      role: "assistant",
      content: "live assistant row",
    });

    await finalizeAutoReflectionPayload(
      agentId,
      conversationId,
      payload.payloadPath,
      payload.endSnapshotLine,
      true,
    );
    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.reflected_through_message_id).toBe("message-assistant-1");
    expect(state.reflected_completed_steps).toBe(1);
    expect(state.steps_since_last_successful_reflection).toBe(0);
  });

  test("message-id cursor controls whether new payloads are available", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "first", messageId: "u1" },
      {
        kind: "assistant",
        id: "a1",
        text: "done",
        phase: "finished",
        messageId: "a1",
      },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;
    await finalizeAutoReflectionPayload(
      agentId,
      conversationId,
      payload.payloadPath,
      payload.endSnapshotLine,
      true,
    );

    let state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.reflected_through_message_id).toBe("a1");
    expect(state.steps_since_last_successful_reflection).toBe(0);
    await expect(
      buildAutoReflectionPayload(agentId, conversationId),
    ).resolves.toBeNull();

    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u2", text: "second", messageId: "u2" },
    ]);

    state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.steps_since_last_successful_reflection).toBe(0);
    const secondPayload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(secondPayload).not.toBeNull();
    expect(secondPayload?.startMessageId).toBe("u2");
    expect(secondPayload?.endMessageId).toBe("u2");
  });

  test("assistant steps appended during reflection are preserved across finalize", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "first", messageId: "u1" },
      {
        kind: "assistant",
        id: "a1",
        text: "ok",
        phase: "finished",
        messageId: "a1",
      },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;

    // Two more assistant steps complete while reflection is "running".
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u2", text: "second", messageId: "u2" },
      {
        kind: "assistant",
        id: "a2",
        text: "second done",
        phase: "finished",
        messageId: "a2",
      },
    ]);
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u3", text: "third", messageId: "u3" },
      {
        kind: "assistant",
        id: "a3",
        text: "third done",
        phase: "finished",
        messageId: "a3",
      },
    ]);

    await finalizeAutoReflectionPayload(
      agentId,
      conversationId,
      payload.payloadPath,
      payload.endSnapshotLine,
      true,
    );

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(3);
    expect(state.reflected_completed_steps).toBe(1);
    expect(state.steps_since_last_successful_reflection).toBe(2);
    expect(state.reflected_through_message_id).toBe("a1");
  });

  test("assistant-only delta advances completed-step counter", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "hello", messageId: "u1" },
    ]);

    let state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(0);

    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      {
        kind: "assistant",
        id: "a1",
        text: "hi",
        phase: "finished",
        messageId: "a1",
      },
    ]);

    state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(1);
  });

  test("completed-step counter ignores user, reasoning, and tool-call rows", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "hello", messageId: "u1" },
      {
        kind: "reasoning",
        id: "r1",
        text: "thinking",
        phase: "finished",
        messageId: "r1",
      },
      {
        kind: "tool_call",
        id: "tc1",
        toolCallId: "tc1",
        name: "Read",
        argsText: "{}",
        resultText: "done",
        resultOk: true,
        phase: "finished",
      },
      {
        kind: "assistant",
        id: "a1",
        text: "hi",
        phase: "finished",
        messageId: "a1",
      },
    ]);

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(1);
    expect(state.steps_since_last_successful_reflection).toBe(1);
  });

  test("concurrent append and finalize do not lose state updates", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "hello", messageId: "u1" },
      {
        kind: "assistant",
        id: "a1",
        text: "hi",
        phase: "finished",
        messageId: "a1",
      },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;

    await Promise.all([
      appendTranscriptDeltaJsonl(agentId, conversationId, [
        { kind: "user", id: "u2", text: "second", messageId: "u2" },
        {
          kind: "assistant",
          id: "a2",
          text: "second done",
          phase: "finished",
          messageId: "a2",
        },
      ]),
      finalizeAutoReflectionPayload(
        agentId,
        conversationId,
        payload.payloadPath,
        payload.endSnapshotLine,
        true,
      ),
      appendTranscriptDeltaJsonl(agentId, conversationId, [
        { kind: "user", id: "u3", text: "third", messageId: "u3" },
        {
          kind: "assistant",
          id: "a3",
          text: "third done",
          phase: "finished",
          messageId: "a3",
        },
      ]),
    ]);

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(3);
    expect(state.reflected_completed_steps).toBe(1);
    expect(state.steps_since_last_successful_reflection).toBe(2);
    expect(state.reflected_through_message_id).toBe("a1");
  });

  test("concurrent appends to the same conversation serialize via the state lock", async () => {
    const appends = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        appendTranscriptDeltaJsonl(agentId, conversationId, [
          {
            kind: "assistant",
            id: `a${i}`,
            text: `msg ${i}`,
            phase: "finished",
            messageId: `a${i}`,
          },
        ]),
      ),
    );

    expect(appends).toEqual([1, 1, 1, 1, 1]);

    const state = await getReflectionTranscriptState(agentId, conversationId);
    expect(state.total_completed_steps).toBe(5);
  });

  test("meta-reflection counter fires every configured successful reflections", async () => {
    for (let index = 0; index < 2; index += 1) {
      const result = await recordSuccessfulReflectionForMetaTrigger(agentId, {
        interval: 3,
      });
      expect(result.shouldLaunchMetaReflection).toBe(false);
      expect(
        result.state.successful_reflections_since_last_meta_reflection,
      ).toBe(index + 1);
    }

    const third = await recordSuccessfulReflectionForMetaTrigger(agentId, {
      interval: 3,
    });
    expect(third.shouldLaunchMetaReflection).toBe(true);
    expect(third.state.successful_reflections_since_last_meta_reflection).toBe(
      0,
    );
    expect(third.state.total_successful_reflections).toBe(3);
    expect(third.state.last_meta_reflection_started_at).toBeString();

    const meta = await recordMetaReflectionResult(agentId, true);
    expect(meta.total_successful_meta_reflections).toBe(1);
    expect(meta.last_meta_reflection_succeeded_at).toBeString();

    const fourth = await recordSuccessfulReflectionForMetaTrigger(agentId, {
      interval: 3,
    });
    expect(fourth.shouldLaunchMetaReflection).toBe(false);
    expect(fourth.state.successful_reflections_since_last_meta_reflection).toBe(
      1,
    );
    expect(fourth.state.total_successful_reflections).toBe(4);
  });

  test("multi payload recent uses replay slices when conversations are already reflected", async () => {
    const convA = "conv-a";
    const convB = "conv-b";
    await appendTranscriptDeltaJsonl(agentId, convA, [
      { kind: "user", id: "u-a", text: "alpha", messageId: "u-a" },
      {
        kind: "assistant",
        id: "a-a",
        text: "alpha response",
        phase: "finished",
        messageId: "a-a",
      },
    ]);
    await appendTranscriptDeltaJsonl(agentId, convB, [
      { kind: "user", id: "u-b", text: "beta", messageId: "u-b" },
      {
        kind: "assistant",
        id: "a-b",
        text: "beta response",
        phase: "finished",
        messageId: "a-b",
      },
    ]);

    for (const conv of [convA, convB]) {
      const payload = await buildAutoReflectionPayload(agentId, conv);
      expect(payload).not.toBeNull();
      if (!payload) return;
      await finalizeAutoReflectionPayload(
        agentId,
        conv,
        payload.payloadPath,
        payload.endSnapshotLine,
        true,
      );
    }

    const multi = await buildMultiReflectionPayload({
      agentId,
      instruction: "Focus on cross-session coding preferences.",
      selectionPolicy: { mode: "recent", limit: 10 },
    });
    expect(multi).not.toBeNull();
    if (!multi) return;
    expect(multi.manifest.user_instruction).toBe(
      "Focus on cross-session coding preferences.",
    );
    expect(multi.manifest.transcripts).toHaveLength(2);
    expect(multi.manifest.transcripts.every((t) => t.mode === "replay")).toBe(
      true,
    );

    const manifestText = await readFile(multi.payloadPath, "utf-8");
    expect(JSON.parse(manifestText).type).toBe(
      "multi_transcript_reflection_payload",
    );
    for (const slice of multi.manifest.transcripts) {
      const payloadText = await readFile(slice.payload_path, "utf-8");
      const messages = JSON.parse(payloadText);
      expect(messages.some((m: { role: string }) => m.role === "user")).toBe(
        true,
      );
    }
  });

  test("multi payload replay range mode replays recent content even when unreflected content exists", async () => {
    const conv = "conv-replay-mode";
    await appendTranscriptDeltaJsonl(agentId, conv, [
      { kind: "user", id: "u-old", text: "old", messageId: "u-old" },
      {
        kind: "assistant",
        id: "a-old",
        text: "old response",
        phase: "finished",
        messageId: "a-old",
      },
      { kind: "user", id: "u-new", text: "new", messageId: "u-new" },
      {
        kind: "assistant",
        id: "a-new",
        text: "new response",
        phase: "finished",
        messageId: "a-new",
      },
    ]);

    const multi = await buildMultiReflectionPayload({
      agentId,
      selectionPolicy: { mode: "explicit-conversations", conversationIds: [conv] },
      rangeMode: "replay",
      maxReplayTurnsPerConversation: 1,
    });

    expect(multi).not.toBeNull();
    if (!multi) return;
    expect(multi.manifest.transcripts).toHaveLength(1);
    expect(multi.manifest.transcripts[0]?.mode).toBe("replay");
    const payloadText = await readFile(
      multi.manifest.transcripts[0]!.payload_path,
      "utf-8",
    );
    expect(payloadText).toContain("new");
    expect(payloadText).not.toContain("old");
  });

  test("multi finalizer advances only unreflected slices", async () => {
    const replayConv = "conv-replay";
    const freshConv = "conv-fresh";
    await appendTranscriptDeltaJsonl(agentId, replayConv, [
      { kind: "user", id: "u-r", text: "old", messageId: "u-r" },
      {
        kind: "assistant",
        id: "a-r",
        text: "old response",
        phase: "finished",
        messageId: "a-r",
      },
    ]);
    await appendTranscriptDeltaJsonl(agentId, freshConv, [
      { kind: "user", id: "u-f", text: "new", messageId: "u-f" },
      {
        kind: "assistant",
        id: "a-f",
        text: "new response",
        phase: "finished",
        messageId: "a-f",
      },
    ]);

    const replayPayload = await buildAutoReflectionPayload(agentId, replayConv);
    expect(replayPayload).not.toBeNull();
    if (!replayPayload) return;
    await finalizeAutoReflectionPayload(
      agentId,
      replayConv,
      replayPayload.payloadPath,
      replayPayload.endSnapshotLine,
      true,
    );

    const multi = await buildMultiReflectionPayload({
      agentId,
      selectionPolicy: {
        mode: "explicit-conversations",
        conversationIds: [replayConv, freshConv],
      },
    });
    expect(multi).not.toBeNull();
    if (!multi) return;
    expect(
      multi.manifest.transcripts.map((slice) => [
        slice.conversation_id,
        slice.mode,
      ]),
    ).toEqual([
      [replayConv, "replay"],
      [freshConv, "unreflected"],
    ]);

    await finalizeMultiReflectionPayload(agentId, multi.manifest, true);

    const replayState = await getReflectionTranscriptState(agentId, replayConv);
    const freshState = await getReflectionTranscriptState(agentId, freshConv);
    expect(replayState.reflected_through_message_id).toBe("a-r");
    expect(replayState.steps_since_last_successful_reflection).toBe(0);
    expect(freshState.reflected_through_message_id).toBe("a-f");
    expect(freshState.steps_since_last_successful_reflection).toBe(0);
  });

  test("multi finalizer leaves cursors unchanged on failure", async () => {
    const conv = "conv-failure";
    await appendTranscriptDeltaJsonl(agentId, conv, [
      { kind: "user", id: "u1", text: "new", messageId: "u1" },
    ]);
    const multi = await buildMultiReflectionPayload({
      agentId,
      selectionPolicy: {
        mode: "explicit-conversations",
        conversationIds: [conv],
      },
    });
    expect(multi).not.toBeNull();
    if (!multi) return;

    await finalizeMultiReflectionPayload(agentId, multi.manifest, false);

    const state = await getReflectionTranscriptState(agentId, conv);
    expect(state.reflected_through_message_id).toBeUndefined();
    expect(state.steps_since_last_successful_reflection).toBe(0);
  });

  test("listReflectionTranscriptCandidates orders by recent transcript mtime", async () => {
    await appendTranscriptDeltaJsonl(agentId, "older", [
      { kind: "user", id: "u-old", text: "old", messageId: "u-old" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await appendTranscriptDeltaJsonl(agentId, "newer", [
      { kind: "user", id: "u-new", text: "new", messageId: "u-new" },
    ]);

    const candidates = await listReflectionTranscriptCandidates(agentId);
    expect(candidates.map((candidate) => candidate.conversationId)).toEqual([
      "newer",
      "older",
    ]);
  });

  test("buildParentMemorySnapshot renders tree descriptions and system <memory> blocks", async () => {
    const memoryDir = join(testRoot, "memory");
    const normalizedMemoryDir = memoryDir.replace(/\\/g, "/");
    await mkdir(join(memoryDir, "system"), { recursive: true });
    await mkdir(join(memoryDir, "reference"), { recursive: true });
    await mkdir(join(memoryDir, "skills", "bird"), { recursive: true });

    await writeFile(
      join(memoryDir, "system", "human.md"),
      "---\ndescription: User context\n---\nDr. Wooders prefers direct answers.\n",
      "utf-8",
    );
    await writeFile(
      join(memoryDir, "reference", "project.md"),
      "---\ndescription: Project notes\n---\nletta-code CLI details\n",
      "utf-8",
    );
    await writeFile(
      join(memoryDir, "skills", "bird", "SKILL.md"),
      "---\nname: bird\ndescription: X/Twitter CLI for posting\n---\nThis body should not be inlined into parent memory.\n",
      "utf-8",
    );

    const snapshot = await buildParentMemorySnapshot(memoryDir);

    expect(snapshot).toContain("<parent_memory>");
    expect(snapshot).toContain("<memory_filesystem>");
    expect(snapshot).toContain("/memory/");
    expect(snapshot).toContain("system/");
    expect(snapshot).toContain("reference/");
    expect(snapshot).toContain("skills/");
    expect(snapshot).toContain("project.md (Project notes)");
    expect(snapshot).toContain("SKILL.md (X/Twitter CLI for posting)");

    expect(snapshot).toContain("<memory>");
    expect(snapshot).toContain(
      `<path>${normalizedMemoryDir}/system/human.md</path>`,
    );
    expect(snapshot).toContain("Dr. Wooders prefers direct answers.");
    expect(snapshot).toContain("</memory>");

    expect(snapshot).not.toContain(
      `<path>${normalizedMemoryDir}/reference/project.md</path>`,
    );
    expect(snapshot).not.toContain("letta-code CLI details");
    expect(snapshot).not.toContain(
      "This body should not be inlined into parent memory.",
    );
    expect(snapshot).toContain("</parent_memory>");
  });

  test("buildParentMemorySnapshot collapses large users directory with omission marker", async () => {
    process.env[DIRECTORY_LIMIT_ENV.memfsTreeMaxChildrenPerDir] = "3";

    const memoryDir = join(testRoot, "memory-large-users");
    await mkdir(join(memoryDir, "system"), { recursive: true });
    await mkdir(join(memoryDir, "users"), { recursive: true });

    await writeFile(
      join(memoryDir, "system", "human.md"),
      "---\ndescription: User context\n---\nSystem content\n",
      "utf-8",
    );

    for (let idx = 0; idx < 10; idx += 1) {
      const suffix = String(idx).padStart(2, "0");
      await writeFile(
        join(memoryDir, "users", `user_${suffix}.md`),
        `---\ndescription: User block ${suffix}\n---\ncontent ${suffix}\n`,
        "utf-8",
      );
    }

    const snapshot = await buildParentMemorySnapshot(memoryDir);

    expect(snapshot).toContain("users/");
    expect(snapshot).toContain("… (7 more entries)");
    expect(snapshot).not.toContain("user_09.md");
  });

  test("buildParentMemorySnapshot truncates large system memory previews", async () => {
    const memoryDir = join(testRoot, "memory-large-system");
    const normalizedMemoryDir = memoryDir.replace(/\\/g, "/");
    await mkdir(join(memoryDir, "system"), { recursive: true });

    const largeContent = `---\ndescription: Large system memory\n---\nSTART\n${"x".repeat(60_000)}\nEND_SHOULD_BE_TRUNCATED\n`;
    await writeFile(
      join(memoryDir, "system", "large.md"),
      largeContent,
      "utf-8",
    );
    await writeFile(
      join(memoryDir, "system", "small.md"),
      "---\ndescription: Small system memory\n---\nsmall content\n",
      "utf-8",
    );

    const snapshot = await buildParentMemorySnapshot(memoryDir);

    expect(snapshot.length).toBeLessThanOrEqual(
      REFLECTION_PARENT_MEMORY_SNAPSHOT_CHAR_LIMIT,
    );
    expect(estimateStartupContextTokens(snapshot)).toBeLessThanOrEqual(
      REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT,
    );
    expect(snapshot).toContain("<memory_filesystem>");
    expect(snapshot).toContain("large.md");
    expect(snapshot).toContain(
      `<path>${normalizedMemoryDir}/system/large.md</path>`,
    );
    expect(snapshot).toContain("START");
    expect(snapshot).toContain("Memory preview truncated");
    expect(snapshot).not.toContain("END_SHOULD_BE_TRUNCATED");
    expect(snapshot).toContain("</parent_memory>");
  });

  test("buildReflectionSubagentPrompt uses expanded reflection instructions", () => {
    const prompt = buildReflectionSubagentPrompt({
      instruction: "Focus on repo gotchas.",
      memoryDir: "/tmp/memory",
      parentMemory: "<parent_memory>snapshot</parent_memory>",
    });

    expect(prompt).toContain("Review the conversation transcript");
    expect(prompt).not.toContain("Your current working directory is:");
    expect(prompt).toContain("The payload path is available as the");
    expect(prompt).not.toContain("multi_transcript_reflection_payload");
    expect(prompt).not.toContain('mode: "replay"');
    // Prompt references the $TRANSCRIPT_PATH env var (resolved via Bash),
    // not a literal absolute path.
    expect(prompt).toContain("$TRANSCRIPT_PATH");
    expect(prompt).toContain("cat $TRANSCRIPT_PATH");
    expect(prompt).not.toContain("/tmp/transcript");
    expect(prompt).toContain(
      "In-context memory (in the parent agent's system prompt) is stored in the `system/` folder and are rendered in <memory> tags below.",
    );
    expect(prompt).toContain(
      "Additional memory files (such as skills and external memory) may also be read and modified.",
    );
    expect(prompt).toContain("Additional user-provided reflection instruction");
    expect(prompt).toContain("Focus on repo gotchas.");
    expect(prompt).toContain("<parent_memory>snapshot</parent_memory>");
  });

  test("buildReflectionSubagentPrompt adds multi-conversation instructions only when requested", () => {
    const standardPrompt = buildReflectionSubagentPrompt({
      memoryDir: "/tmp/memory",
      parentMemory: "<parent_memory>snapshot</parent_memory>",
    });
    const multiPrompt = buildReflectionSubagentPrompt({
      mode: "multi",
      memoryDir: "/tmp/memory",
      parentMemory: "<parent_memory>snapshot</parent_memory>",
    });

    expect(standardPrompt).not.toContain("multi_transcript_reflection_payload");
    expect(multiPrompt).toContain("multi_transcript_reflection_payload");
  });

  test("reflection payload drops tool call results and truncates args", async () => {
    const longArgs = "a".repeat(500);
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "run a search", messageId: "u1" },
      {
        kind: "tool_call",
        id: "tc1",
        toolCallId: "tc1",
        name: "Grep",
        argsText: longArgs,
        resultText: "found 42 matches in 10 files",
        resultOk: true,
        phase: "finished",
      },
      {
        kind: "assistant",
        id: "a1",
        text: "Found results",
        phase: "finished",
        messageId: "a1",
      },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;

    const payloadText = await readFile(payload.payloadPath, "utf-8");
    const messages = JSON.parse(payloadText);

    // Tool call should be present with truncated args
    const toolMsg = messages.find(
      (m: { tool_calls?: unknown[] }) => m.tool_calls,
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_calls[0].name).toBe("Grep");
    expect(toolMsg.tool_calls[0].args).toContain("…[truncated]");
    expect(toolMsg.tool_calls[0].args.length).toBeLessThan(longArgs.length);
    // Tool result should NOT be present anywhere
    expect(payloadText).not.toContain("found 42 matches");
    // User and assistant messages should be present
    expect(messages).toContainEqual({ role: "user", content: "run a search" });
    expect(messages).toContainEqual({
      role: "assistant",
      content: "Found results",
    });
  });

  test("reflection payload strips inline base64 images from text", async () => {
    const userTextWithImage =
      "Check this: ![screenshot](data:image/png;base64,iVBORw0KGgoAAAANS) and tell me what you see";
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: userTextWithImage, messageId: "u1" },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;

    const payloadText = await readFile(payload.payloadPath, "utf-8");
    const messages = JSON.parse(payloadText);
    const userMsg = messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg.content).not.toContain("data:image/png;base64");
    expect(userMsg.content).toContain("[image]");
    expect(userMsg.content).toContain("Check this:");
    expect(userMsg.content).toContain("and tell me what you see");
  });

  test("reflection payload prepends filtered system prompt when provided", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "hello", messageId: "u1" },
    ]);

    const systemPrompt = [
      "You are a helpful coding assistant.",
      "",
      "<memory>",
      "<self>I am a persona block</self>",
      "<human>User info here</human>",
      "</memory>",
      "",
      "<available_skills>",
      "skill1, skill2",
      "</available_skills>",
      "",
      "Always be concise.",
    ].join("\n");

    const payload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
      systemPrompt,
    );
    expect(payload).not.toBeNull();
    if (!payload) return;

    const payloadText = await readFile(payload.payloadPath, "utf-8");
    const messages = JSON.parse(payloadText);
    // Filtered system prompt should be the first message
    const systemMsg = messages[0];
    expect(systemMsg.role).toBe("system");
    expect(systemMsg.content).toContain("You are a helpful coding assistant.");
    expect(systemMsg.content).toContain("Always be concise.");
    // Dynamic sections should be stripped
    expect(systemMsg.content).not.toContain("I am a persona block");
    expect(systemMsg.content).not.toContain("User info here");
    expect(systemMsg.content).not.toContain("skill1, skill2");
    expect(systemMsg.content).not.toContain("<available_skills>");
    // Transcript should follow
    expect(messages).toContainEqual({ role: "user", content: "hello" });
  });

  test("filterSystemPromptForReflection strips all dynamic sections", () => {
    const raw = [
      "Core instructions here.",
      "<memory><self>persona</self><human>user data</human></memory>",
      "<system-reminder>This is a reminder</system-reminder>",
      "<memory_metadata>agent-id: foo</memory_metadata>",
      "<available_skills>skill list</available_skills>",
      "Final instructions.",
    ].join("\n");

    const filtered = filterSystemPromptForReflection(raw);
    expect(filtered).toContain("Core instructions here.");
    expect(filtered).toContain("Final instructions.");
    expect(filtered).not.toContain("persona");
    expect(filtered).not.toContain("user data");
    expect(filtered).not.toContain("This is a reminder");
    expect(filtered).not.toContain("agent-id: foo");
    expect(filtered).not.toContain("skill list");
  });

  test("filterSystemPromptForReflection strips standalone memory sub-tags", () => {
    const raw = [
      "You are Letta Code.",
      "",
      "<self>",
      "I'm a coding assistant.",
      "</self>",
      "",
      "<human>",
      "The user likes TypeScript.",
      "</human>",
      "",
      "Keep being helpful.",
    ].join("\n");

    const filtered = filterSystemPromptForReflection(raw);
    expect(filtered).toContain("You are Letta Code.");
    expect(filtered).toContain("Keep being helpful.");
    expect(filtered).not.toContain("I'm a coding assistant.");
    expect(filtered).not.toContain("The user likes TypeScript.");
  });

  test("filterSystemPromptForReflection strips the # Memory markdown section", () => {
    const raw = [
      "You are a persistent coding agent.",
      "",
      "# How you work",
      "",
      "Never modify code you haven't read.",
      "",
      "# Memory",
      "",
      "Your memory is projected onto the local memory filesystem.",
      "",
      "## Memory structure",
      "",
      "Files in system/ are pinned into your prompt.",
      "",
      "## Syncing",
      "",
      "```bash",
      "git push",
      "```",
    ].join("\n");

    const filtered = filterSystemPromptForReflection(raw);
    expect(filtered).toContain("You are a persistent coding agent.");
    expect(filtered).toContain("# How you work");
    expect(filtered).toContain("Never modify code you haven't read.");
    // Everything from "# Memory" onward should be stripped
    expect(filtered).not.toContain("# Memory");
    expect(filtered).not.toContain("memory filesystem");
    expect(filtered).not.toContain("Memory structure");
    expect(filtered).not.toContain("pinned into your prompt");
    expect(filtered).not.toContain("Syncing");
    expect(filtered).not.toContain("git push");
  });

  test("reflection selector prompt describes auto-only mode", () => {
    const prompt = buildReflectionSelectorPrompt({
      instruction: "Find repeated mistakes.",
    });
    expect(prompt).toContain("auto_transcript_reflection_candidates");
    expect(prompt).toContain("Do not edit memory files");
    expect(prompt).toContain("Return strict JSON");
    expect(prompt).toContain("Find repeated mistakes.");
  });

  test("readReflectionAutoSelection validates and caps selector report", async () => {
    const selected = await readReflectionAutoSelection({
      selectionReport: JSON.stringify({
        selected_conversations: [
          { conversation_id: "conv-a", reason: "correction", priority: "high" },
          { conversation_id: "conv-a", reason: "duplicate", priority: "low" },
          {
            conversation_id: "conv-b",
            reason: "repo gotcha",
            priority: "medium",
          },
        ],
      }),
      candidates: {
        schema_version: 1,
        type: "auto_transcript_reflection_candidates",
        agent_id: agentId,
        created_at: new Date().toISOString(),
        max_selected: 1,
        instructions: "select",
        candidates: [
          {
            conversation_id: "conv-a",
            total_completed_turns: 3,
            reflected_completed_turns: 0,
            turns_since_last_successful_reflection: 3,
            has_unreflected_content: true,
            is_current_conversation: false,
            sources: ["unreflected"],
            search_scores: [],
            heuristic_score: 10,
          },
          {
            conversation_id: "conv-b",
            total_completed_turns: 3,
            reflected_completed_turns: 3,
            turns_since_last_successful_reflection: 0,
            has_unreflected_content: false,
            is_current_conversation: false,
            sources: ["search:coding-style"],
            search_scores: [],
            heuristic_score: 8,
          },
        ],
      },
    });

    expect(selected).toEqual([
      { conversation_id: "conv-a", reason: "correction", priority: "high" },
    ]);
  });

  test("readReflectionAutoSelection accepts fenced selector JSON", async () => {
    const selected = await readReflectionAutoSelection({
      selectionReport:
        '```json\n{"selected_conversations":[{"conversation_id":"conv-a","reason":"correction"}]}\n```',
      candidates: {
        schema_version: 1,
        type: "auto_transcript_reflection_candidates",
        agent_id: agentId,
        created_at: new Date().toISOString(),
        max_selected: 5,
        instructions: "select",
        candidates: [
          {
            conversation_id: "conv-a",
            total_completed_turns: 3,
            reflected_completed_turns: 0,
            turns_since_last_successful_reflection: 3,
            has_unreflected_content: true,
            is_current_conversation: false,
            sources: ["unreflected"],
            search_scores: [],
            heuristic_score: 10,
          },
        ],
      },
    });

    expect(selected).toEqual([
      { conversation_id: "conv-a", reason: "correction" },
    ]);
  });
});
