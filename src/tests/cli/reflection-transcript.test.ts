import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Line } from "../../cli/helpers/accumulator";
import {
  appendTranscriptDeltaJsonl,
  buildAutoReflectionPayload,
  buildRememberPayloadFromLines,
  finalizeAutoReflectionPayload,
  finalizeRememberPayload,
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
    const lines: Line[] = [
      { kind: "user", id: "u1", text: "hello" },
      {
        kind: "assistant",
        id: "a1",
        text: "hi there",
        phase: "finished",
      },
    ];

    await appendTranscriptDeltaJsonl(agentId, conversationId, lines);

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

  test("remember payload from rendered lines does not modify auto cursor", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "alpha" },
      { kind: "assistant", id: "a1", text: "beta", phase: "finished" },
    ]);

    const autoPayload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(autoPayload).not.toBeNull();
    if (!autoPayload) return;

    await finalizeAutoReflectionPayload(
      agentId,
      conversationId,
      autoPayload.payloadPath,
      autoPayload.endSnapshotLine,
      true,
    );

    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    const beforeRaw = await readFile(paths.statePath, "utf-8");
    const before = JSON.parse(beforeRaw) as { auto_cursor_line: number };

    const renderedLines: Line[] = [
      { kind: "user", id: "u-render", text: "most recent rendered" },
      {
        kind: "assistant",
        id: "a-render",
        text: "rendered answer",
        phase: "finished",
      },
    ];
    const rememberPayload = await buildRememberPayloadFromLines(
      agentId,
      conversationId,
      renderedLines,
    );
    expect(rememberPayload).not.toBeNull();
    if (!rememberPayload) return;

    const rememberText = await readFile(rememberPayload.payloadPath, "utf-8");
    expect(rememberText).toContain("<user>most recent rendered</user>");
    expect(rememberText).toContain("<assistant>rendered answer</assistant>");
    expect(rememberText).not.toContain("<user>alpha</user>");

    await finalizeRememberPayload(
      agentId,
      conversationId,
      rememberPayload.payloadPath,
      true,
    );

    expect(existsSync(rememberPayload.payloadPath)).toBe(true);

    const afterRaw = await readFile(paths.statePath, "utf-8");
    const after = JSON.parse(afterRaw) as { auto_cursor_line: number };
    expect(after.auto_cursor_line).toBe(before.auto_cursor_line);
  });
});
