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
  filterSystemPromptForReflection,
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
    const state = JSON.parse(stateRaw) as { auto_cursor_line: number };
    expect(state.auto_cursor_line).toBe(0);

    const retried = await buildAutoReflectionPayload(agentId, conversationId);
    expect(retried).not.toBeNull();
  });

  test("auto payload clamps out-of-range cursor and resumes on new transcript lines", async () => {
    await appendTranscriptDeltaJsonl(agentId, conversationId, [
      { kind: "user", id: "u1", text: "first", messageId: "u1" },
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
      {
        kind: "assistant",
        id: "a2",
        text: "second",
        phase: "finished",
        messageId: "a2",
      },
    ]);

    const secondAttempt = await buildAutoReflectionPayload(
      agentId,
      conversationId,
    );
    expect(secondAttempt).not.toBeNull();
    if (!secondAttempt) return;
    expect(secondAttempt.startMessageId).toBe("a2");
    expect(secondAttempt.endMessageId).toBe("a2");

    const payloadText = await readFile(secondAttempt.payloadPath, "utf-8");
    const messages = JSON.parse(payloadText);
    expect(messages).toContainEqual({ role: "assistant", content: "second" });
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
});
