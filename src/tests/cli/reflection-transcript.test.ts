import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTranscriptDeltaJsonl,
  buildAutoReflectionPayload,
  buildParentMemorySnapshot,
  buildReflectionSubagentPrompt,
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

  test("auto payload is chunked and advances cursor incrementally", async () => {
    const bigText = "x".repeat(30_000);
    for (let i = 0; i < 12; i += 1) {
      await appendTranscriptDeltaJsonl(agentId, conversationId, [
        { kind: "user", id: `u-${i}`, text: `${i}:${bigText}` },
      ]);
    }

    const firstPayload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(firstPayload).not.toBeNull();
    if (!firstPayload) return;

    await finalizeAutoReflectionPayload(
      agentId,
      conversationId,
      firstPayload.payloadPath,
      firstPayload.endSnapshotLine,
      true,
    );

    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    const afterFirstRaw = await readFile(paths.statePath, "utf-8");
    const afterFirst = JSON.parse(afterFirstRaw) as {
      auto_cursor_line: number;
    };
    expect(afterFirst.auto_cursor_line).toBeLessThan(12);
    expect(afterFirst.auto_cursor_line).toBeGreaterThan(0);

    const secondPayload = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(secondPayload).not.toBeNull();
    if (!secondPayload) return;
    expect(secondPayload.endSnapshotLine).toBeGreaterThan(
      afterFirst.auto_cursor_line,
    );
  });

  test("buildParentMemorySnapshot inlines system content and skill descriptions", async () => {
    const memoryDir = join(testRoot, "memory");
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

    expect(snapshot).toContain("<system_memory>");
    expect(snapshot).toContain("<path=system/human.md>");
    expect(snapshot).toContain("Dr. Wooders prefers direct answers.");

    expect(snapshot).not.toContain("<path=reference/project.md>");
    expect(snapshot).not.toContain("letta-code CLI details");

    expect(snapshot).toContain("<skill_descriptions>");
    expect(snapshot).toContain("<path=skills/bird/SKILL.md>");
    expect(snapshot).toContain("X/Twitter CLI for posting");
    expect(snapshot).not.toContain(
      "This body should not be inlined into parent memory.",
    );
    expect(snapshot).toContain("</parent_memory>");
  });

  test("buildReflectionSubagentPrompt embeds parent memory when provided", () => {
    const prompt = buildReflectionSubagentPrompt({
      transcriptPath: "/tmp/transcript.txt",
      memoryDir: "/tmp/memory",
      cwd: "/tmp/work",
      parentMemory: "<parent_memory>snapshot</parent_memory>",
    });

    expect(prompt).toContain("Review the conversation transcript");
    expect(prompt).toContain(
      "The current conversation transcript has been saved",
    );
    expect(prompt).toContain("Parent memory is provided inline below");
    expect(prompt).toContain("<parent_memory>snapshot</parent_memory>");
  });
});
