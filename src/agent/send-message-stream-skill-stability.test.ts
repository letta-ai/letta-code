import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { Backend } from "@/backend";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import { invalidateClientSkillsPayloadCache } from "./client-skills";
import { sendMessageStreamWithBackend } from "./message";

afterEach(() => invalidateClientSkillsPayloadCache());

async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Skill ${name}\n---\nBody of ${name}`,
  );
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "letta-skill-stability-"));
  const skillsDirectory = join(root, "skills");
  await mkdir(skillsDirectory);
  const bodies: MessageCreateParams[] = [];
  let nextChunks: Array<Record<string, unknown>> = [];
  // Capture the backend boundary; skill discovery and file parsing are real.
  const backend = {
    createConversationMessageStream: async (
      _conversationId: string,
      body: MessageCreateParams,
    ) => {
      bodies.push(body);
      const chunks = nextChunks;
      nextChunks = [];
      return {
        async *[Symbol.asyncIterator]() {
          yield* chunks;
        },
      };
    },
  } as unknown as Backend;
  const preparedToolContext = await prepareToolExecutionContextForSpecificTools(
    [],
    { runtimeContext: { skillsDirectory, workingDirectory: root } },
  );
  const send = async (conversationId = "conv-stable") => {
    invalidateClientSkillsPayloadCache();
    const stream = await sendMessageStreamWithBackend(
      backend,
      conversationId,
      [{ type: "message", role: "user", content: "hello" }],
      { skillSources: ["project"], preparedToolContext },
    );
    for await (const _chunk of stream) {
      /* drain */
    }
    const body = bodies.at(-1);
    if (!body) throw new Error("No request recorded");
    const reminder = body.messages?.[1];
    return {
      clientSkills: JSON.stringify(body.client_skills),
      names: (body.client_skills ?? []).map((skill) => skill.name),
      reminder:
        reminder?.type === "message" && typeof reminder.content === "string"
          ? reminder.content
          : null,
    };
  };
  return {
    root,
    skillsDirectory,
    send,
    streamNext: (chunks: Array<Record<string, unknown>>) => {
      nextChunks = chunks;
    },
  };
}

describe("client_skills prefix stability", () => {
  test("a transient skill dip does not change client_skills", async () => {
    const { root, skillsDirectory, send } = await setup();
    try {
      await writeSkill(skillsDirectory, "alpha");
      await writeSkill(skillsDirectory, "bravo");
      const first = await send();
      expect(first.names).toEqual(["alpha", "bravo"]);
      expect(first.reminder).toBeNull();

      await rm(join(skillsDirectory, "bravo"), { recursive: true });
      const dipped = await send();
      expect(dipped.clientSkills).toBe(first.clientSkills);
      expect(dipped.reminder).toContain("Skills no longer available:\n- bravo");

      await writeSkill(skillsDirectory, "bravo");
      const restored = await send();
      expect(restored.clientSkills).toBe(first.clientSkills);
      expect(restored.reminder).toContain("<name>bravo</name>");
      expect(restored.reminder).not.toContain("no longer available");

      const steady = await send();
      expect(steady.clientSkills).toBe(first.clientSkills);
      expect(steady.reminder).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a new skill is announced once without editing client_skills", async () => {
    const { root, skillsDirectory, send } = await setup();
    try {
      await writeSkill(skillsDirectory, "alpha");
      const first = await send();
      await writeSkill(skillsDirectory, "charlie");
      const added = await send();
      expect(added.clientSkills).toBe(first.clientSkills);
      expect(added.reminder).toContain("<name>charlie</name>");
      expect(added.reminder).not.toContain("Body of charlie");
      const next = await send();
      expect(next.clientSkills).toBe(first.clientSkills);
      expect(next.reminder).toBeNull();
      // Another conversation starts from the current full catalog.
      const other = await send("conv-other");
      expect(other.names).toEqual(["alpha", "charlie"]);
      expect(other.reminder).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a compaction re-baselines client_skills to the current catalog", async () => {
    const { root, skillsDirectory, send, streamNext } = await setup();
    try {
      await writeSkill(skillsDirectory, "alpha");
      await send();
      await writeSkill(skillsDirectory, "charlie");
      streamNext([{ message_type: "summary_message", summary: "compacted" }]);
      const compacted = await send();
      expect(compacted.names).toEqual(["alpha"]);
      expect(compacted.reminder).toContain("<name>charlie</name>");
      await writeSkill(skillsDirectory, "delta");
      const rebaselined = await send();
      expect(rebaselined.names).toEqual(["alpha", "charlie", "delta"]);
      expect(rebaselined.reminder).toBeNull();
      const after = await send();
      expect(after.clientSkills).toBe(rebaselined.clientSkills);
      expect(after.reminder).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
