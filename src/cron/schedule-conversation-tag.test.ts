import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@/backend/local/local-backend";
import { SCHEDULE_ORIGIN_TAG } from "@/cron/scheduled-task-prompt";

describe("scheduled conversation tagging", () => {
  test("persists source tags supplied at conversation creation", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "schedule-tag-"));

    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({ name: "Local" } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
        summary: "Nightly digest",
        tags: [SCHEDULE_ORIGIN_TAG],
      } as never);

      expect(Reflect.get(conversation, "tags")).toEqual([SCHEDULE_ORIGIN_TAG]);
      expect(conversation.summary).toBe("Nightly digest");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
