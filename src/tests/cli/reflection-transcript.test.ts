import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTranscriptDeltaJsonl,
  buildAutoReflectionPayload,
  finalizeAutoReflectionPayload,
  getReflectionTranscriptPaths,
} from "../../cli/helpers/reflectionTranscript";

describe("reflectionTranscript helper", () => {
  const agentId = "agent-test";
  const conversationId = "conv-test";
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "letta-transcript-test-"));
    process.env.LETTA_TRANSCRIPT_ROOT = testRoot;
  });

  afterEach(async () => {
    delete process.env.LETTA_TRANSCRIPT_ROOT;
    await rm(testRoot, { recursive: true, force: true });
  });

  test("auto payload advances cursor on success", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "hello" },
      {
        kind: "assistant",
        id: "a1",
        text: "hi there",
        phase: "finished",
      },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;

    const payloadText = await readFile(payload.payloadPath, "utf-8");
    expect(payloadText).toContain("<user>hello</user>");
    expect(payloadText).toContain("<assistant>hi there</assistant>");

    await finalizeAutoReflectionPayload(
      agentId,
      conversationId,
      payload.payloadPath,
      payload.endSnapshotLine,
      true,
    );

    expect(existsSync(payload.payloadPath)).toBe(true);

    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    const stateRaw = await readFile(paths.statePath, "utf-8");
    const state = JSON.parse(stateRaw) as { auto_cursor_line: number };
    expect(state.auto_cursor_line).toBe(payload.endSnapshotLine);

    const secondPayload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(secondPayload).toBeNull();
  });

  test("auto payload keeps cursor on failure", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "remember this" },
    ]);

    const payload = await buildAutoReflectionPayload(agentId, conversationId);
    expect(payload).not.toBeNull();
    if (!payload) return;

    await finalizeAutoReflectionPayload(
      agentId,
      conversationId,
      payload.payloadPath,
      payload.endSnapshotLine,
      false,
    );

    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    const stateRaw = await readFile(paths.statePath, "utf-8");
    const state = JSON.parse(stateRaw) as { auto_cursor_line: number };
    expect(state.auto_cursor_line).toBe(0);

    const retried = await buildAutoReflectionPayload(agentId, conversationId);
    expect(retried).not.toBeNull();
  });

  test("auto payload clamps out-of-range cursor and resumes on new transcript lines", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "first" },
    ]);

    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await writeFile(
      paths.statePath,
      `${JSON.stringify({ auto_cursor_line: 999 })}\n`,
      "utf-8",
    );

    const firstAttempt = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(firstAttempt).toBeNull();

    const clampedRaw = await readFile(paths.statePath, "utf-8");
    const clamped = JSON.parse(clampedRaw) as { auto_cursor_line: number };
    expect(clamped.auto_cursor_line).toBe(1);

    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "assistant", id: "a2", text: "second", phase: "finished" },
    ]);

    const secondAttempt = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(secondAttempt).not.toBeNull();
    if (!secondAttempt) return;

    const payloadText = await readFile(secondAttempt.payloadPath, "utf-8");
    expect(payloadText).toContain("<assistant>second</assistant>");
  });
});
