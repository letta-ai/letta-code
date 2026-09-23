import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend, type Backend } from "@/backend";
import { DeterministicPongExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { prepareMemoryHandoff } from "./memory-handoff";

const originalRoot = process.env.LETTA_TRANSCRIPT_ROOT;
let root: string | undefined;
afterEach(async () => {
  __testSetBackend(null);
  if (originalRoot === undefined) delete process.env.LETTA_TRANSCRIPT_ROOT;
  else process.env.LETTA_TRANSCRIPT_ROOT = originalRoot;
  if (root) await rm(root, { recursive: true, force: true });
});

test("local backend handoff includes history beyond the first page", async () => {
  root = await mkdtemp(join(tmpdir(), "memory-handoff-local-"));
  process.env.LETTA_TRANSCRIPT_ROOT = root;
  const backend = new LocalBackend({
    storageDir: join(root, "store"),
    executor: new DeterministicPongExecutor(),
    memfsEnabled: false,
  });
  __testSetBackend(backend);
  const agent = await backend.createAgent({ name: "Handoff test" });
  const conversation = await backend.createConversation({ agent_id: agent.id });
  const stream = await backend.createConversationMessageStream(
    conversation.id,
    {
      agent_id: agent.id,
      messages: Array.from({ length: 105 }, (_, i) => ({
        role: "user" as const,
        content: `Parent fact ${i}`,
      })),
    },
  );
  for await (const _chunk of stream) {
    // Persist the real local transcript before preparing the worker handoff.
  }
  const handoff = await prepareMemoryHandoff({
    agentId: agent.id,
    conversationId: conversation.id,
    memoryDir: join(root, "memory"),
    assignment: "Remember the latest fact.",
  });
  if (!handoff.transcriptPath) throw new Error("Missing transcript");
  const snapshot = await readFile(handoff.transcriptPath, "utf8");
  expect(JSON.parse(snapshot)).toHaveLength(106);
  expect(snapshot).toContain("Parent fact 0");
  expect(snapshot).toContain("Parent fact 104");
  expect(handoff.prompt).not.toContain("Parent fact");
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
      return {
        getPaginatedItems: () => [
          {
            message_type: "system_message",
            content: "parent system instructions",
          },
          { message_type: "reasoning_message", reasoning: "private reasoning" },
          {
            message_type: "user_message",
            content: "old facts in parent history",
          },
        ],
      };
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

test("a full page whose cursor cannot advance ends the export", async () => {
  root = await mkdtemp(join(tmpdir(), "memory-handoff-cursor-"));
  process.env.LETTA_TRANSCRIPT_ROOT = root;
  let requests = 0;
  const page = Array.from({ length: 100 }, (_, index) => ({
    message_type: "user_message",
    content: `message ${index}`,
    // No id: a backend that omits ids cannot page further.
  }));
  __testSetBackend({
    listConversationMessages: async () => {
      requests++;
      return { getPaginatedItems: () => page };
    },
  } as unknown as Backend);
  const handoff = await prepareMemoryHandoff({
    agentId: "agent-cursor",
    conversationId: "conv-cursor",
    memoryDir: join(root, "memory"),
    assignment: "Remember the cursor",
  });
  expect(requests).toBe(1);
  if (!handoff.transcriptPath) throw new Error("Missing snapshot");
  expect(
    JSON.parse(await readFile(handoff.transcriptPath, "utf8")),
  ).toHaveLength(100);
});

test("cancelling the task stops the transcript export", async () => {
  root = await mkdtemp(join(tmpdir(), "memory-handoff-abort-"));
  process.env.LETTA_TRANSCRIPT_ROOT = root;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  __testSetBackend({
    listConversationMessages: async (
      _conversationId: string,
      _body: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      receivedSignal = options?.signal;
      // A slow page: only the signal can end this request.
      await new Promise<void>((_, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
      return { getPaginatedItems: () => [] };
    },
  } as unknown as Backend);
  const handoff = prepareMemoryHandoff({
    agentId: "agent-abort",
    conversationId: "conv-abort",
    memoryDir: join(root, "memory"),
    assignment: "Remember the abort",
    signal: controller.signal,
  });
  await Bun.sleep(10);
  controller.abort();
  await expect(handoff).rejects.toThrow("aborted");
  expect(receivedSignal).toBe(controller.signal);
});
