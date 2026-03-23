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
import { DIRECTORY_LIMIT_ENV } from "../../utils/directoryLimits";

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

  test("buildReflectionSubagentPrompt uses expanded reflection instructions", () => {
    const prompt = buildReflectionSubagentPrompt({
      transcriptPath: "/tmp/transcript.txt",
      memoryDir: "/tmp/memory",
      cwd: "/tmp/work",
      parentMemory: "<parent_memory>snapshot</parent_memory>",
    });

    expect(prompt).toContain("Review the conversation transcript");
    expect(prompt).toContain("Your current working directory is: /tmp/work");
    expect(prompt).toContain(
      "The current conversation transcript has been saved",
    );
    expect(prompt).toContain(
      "In-context memory (in the parent agent's system prompt) is stored in the `system/` folder and are rendered in <memory> tags below.",
    );
    expect(prompt).toContain(
      "Additional memory files (such as skills and external memory) may also be read and modified.",
    );
    expect(prompt).toContain("<parent_memory>snapshot</parent_memory>");
  });
});
