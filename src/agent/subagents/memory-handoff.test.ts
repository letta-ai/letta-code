import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend, type Backend } from "@/backend";
import { prepareMemoryHandoff } from "./memory-handoff";

const originalRoot = process.env.LETTA_TRANSCRIPT_ROOT;
let root: string | undefined;
afterEach(async () => {
  __testSetBackend(null);
  if (originalRoot === undefined) delete process.env.LETTA_TRANSCRIPT_ROOT;
  else process.env.LETTA_TRANSCRIPT_ROOT = originalRoot;
  if (root) await rm(root, { recursive: true, force: true });
});

test("repeated launches preserve separate read-only snapshots without inlining history", async () => {
  root = await mkdtemp(join(tmpdir(), "memory-handoff-"));
  process.env.LETTA_TRANSCRIPT_ROOT = root;
  __testSetBackend({
    listConversationMessages: async (
      conversationId: string,
      options: { agent_id: string },
    ) => {
      expect(conversationId).toBe("conv-parent");
      expect(options.agent_id).toBe("agent-parent");
      return [
        {
          message_type: "system_message",
          content: "parent system instructions",
        },
        { message_type: "reasoning_message", reasoning: "private reasoning" },
        {
          message_type: "user_message",
          content: "old facts in parent history",
        },
      ];
    },
  } as unknown as Backend);
  const params = {
    agentId: "agent-parent",
    conversationId: "conv-parent",
    memoryDir: "/exact/parent/memory",
    assignment: "SQLite is only for local tests.",
  };
  const [first, second] = await Promise.all([
    prepareMemoryHandoff(params),
    prepareMemoryHandoff(params),
  ]);
  expect(first.transcriptPath).toBeDefined();
  expect(first.transcriptPath).not.toBe(second.transcriptPath);
  if (!first.transcriptPath || !second.transcriptPath)
    throw new Error("Missing transcript");
  const snapshot = await readFile(first.transcriptPath, "utf8");
  expect(snapshot).toBe(await readFile(second.transcriptPath, "utf8"));
  expect(snapshot).toContain("old facts in parent history");
  expect(snapshot).not.toContain("parent system instructions");
  expect(snapshot).not.toContain("private reasoning");
  if (process.platform !== "win32")
    expect((await stat(first.transcriptPath)).mode & 0o222).toBe(0);
  expect(first.prompt).toContain("Memory repository: /exact/parent/memory");
  expect(first.prompt).toContain(params.assignment);
  expect(first.prompt).not.toContain("old facts in parent history");
});

test("Git repair does not fetch or attach parent history", async () => {
  __testSetBackend({
    listConversationMessages: () => {
      throw new Error("Must not fetch history");
    },
  } as unknown as Backend);
  const result = await prepareMemoryHandoff({
    agentId: "agent-parent",
    conversationId: "conv-parent",
    memoryDir: "/exact/parent/memory",
    assignment: "Repair the merge.",
    repairOnly: true,
  });
  expect(result.transcriptPath).toBeUndefined();
  expect(result.prompt).toContain("Repair the merge.");
  expect(result.prompt).not.toContain("Parent transcript");
});
