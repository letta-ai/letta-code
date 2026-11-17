import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { Backend } from "@/backend";
import {
  notifyConversationCompacted,
  tapConversationCompaction,
} from "@/backend/compaction-events";
import { parseSkillDeltaReminder } from "@/test-utils/skill-delta-reminder";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import { invalidateClientSkillsPayloadCache } from "./client-skills";
import { sendMessageStreamWithBackend } from "./message";

afterEach(() => invalidateClientSkillsPayloadCache());

async function writeSkill(
  root: string,
  name: string,
  description = `Skill ${name}`,
): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}`,
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
  const open = (conversationId = "conv-stable") => {
    invalidateClientSkillsPayloadCache();
    return sendMessageStreamWithBackend(
      backend,
      conversationId,
      [{ type: "message", role: "user", content: "hello" }],
      { skillSources: ["project"], preparedToolContext },
    );
  };
  const send = async (conversationId = "conv-stable") => {
    const stream = await open(conversationId);
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
    backend,
    open,
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
      expect(parseSkillDeltaReminder(dipped.reminder)).toEqual({
        added: [],
        updated: [],
        removed: ["bravo"],
        current: ["alpha"],
      });

      await writeSkill(skillsDirectory, "bravo");
      const restored = await send();
      expect(restored.clientSkills).toBe(first.clientSkills);
      expect(parseSkillDeltaReminder(restored.reminder)).toEqual({
        added: ["bravo"],
        updated: [],
        removed: [],
        current: ["alpha", "bravo"],
      });

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
      expect(parseSkillDeltaReminder(added.reminder)).toEqual({
        added: ["charlie"],
        updated: [],
        removed: [],
        current: ["alpha", "charlie"],
      });
      expect(added.reminder).toContain("Skill charlie");
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
      expect(parseSkillDeltaReminder(compacted.reminder)?.added).toEqual([
        "charlie",
      ]);
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

  test("a description change is reported as updated, against the last reminder", async () => {
    const { root, skillsDirectory, send } = await setup();
    try {
      await writeSkill(skillsDirectory, "alpha");
      await writeSkill(skillsDirectory, "bravo");
      const first = await send();
      await writeSkill(skillsDirectory, "alpha", "Sharper alpha");
      await writeSkill(skillsDirectory, "charlie");
      const changed = await send();
      expect(changed.clientSkills).toBe(first.clientSkills);
      expect(parseSkillDeltaReminder(changed.reminder)).toEqual({
        added: ["charlie"],
        updated: ["alpha"],
        removed: [],
        current: ["alpha", "bravo", "charlie"],
      });
      expect(changed.reminder).toContain("Sharper alpha");
      // The next delta is diffed against what was announced, not the frozen
      // list, so earlier changes are not repeated.
      await rm(join(skillsDirectory, "bravo"), { recursive: true });
      const removed = await send();
      expect(parseSkillDeltaReminder(removed.reminder)).toEqual({
        added: [],
        updated: [],
        removed: ["bravo"],
        current: ["alpha", "charlie"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a manual compaction re-baselines only its own conversation", async () => {
    const { root, skillsDirectory, backend, send } = await setup();
    try {
      await writeSkill(skillsDirectory, "alpha");
      await send("conv-compacted");
      await send("conv-untouched");
      await writeSkill(skillsDirectory, "charlie");
      // What a backend reports after a manual compact request succeeds.
      notifyConversationCompacted({
        backend,
        conversationId: "conv-compacted",
      });
      const compacted = await send("conv-compacted");
      expect(compacted.names).toEqual(["alpha", "charlie"]);
      expect(compacted.reminder).toBeNull();
      const untouched = await send("conv-untouched");
      expect(untouched.names).toEqual(["alpha"]);
      expect(parseSkillDeltaReminder(untouched.reminder)?.added).toEqual([
        "charlie",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a compaction on a resumed stream re-baselines the conversation", async () => {
    const { root, skillsDirectory, backend, send } = await setup();
    try {
      await writeSkill(skillsDirectory, "alpha");
      await send();
      await writeSkill(skillsDirectory, "charlie");
      const resumed = tapConversationCompaction(
        (async function* () {
          yield { message_type: "assistant_message" };
          yield { message_type: "summary_message", summary: "compacted" };
        })(),
        { backend, conversationId: "conv-stable" },
      );
      const seen: unknown[] = [];
      for await (const chunk of resumed) seen.push(chunk);
      expect(seen).toHaveLength(2);
      const next = await send();
      expect(next.names).toEqual(["alpha", "charlie"]);
      expect(next.reminder).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a late summary from a superseded stream does not re-baseline", async () => {
    const { root, skillsDirectory, open, send, streamNext } = await setup();
    try {
      await writeSkill(skillsDirectory, "alpha");
      await send();
      await writeSkill(skillsDirectory, "charlie");
      streamNext([{ message_type: "summary_message", summary: "late" }]);
      // Accept the request but drain its stream only after a newer send.
      const stale = await open();
      const newer = await send();
      for await (const _chunk of stale) {
        /* late summary arrives here */
      }
      // The stale request already delivered the charlie delta.
      expect(newer.reminder).toBeNull();
      const after = await send();
      expect(after.names).toEqual(["alpha"]);
      expect(after.clientSkills).toBe(newer.clientSkills);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
