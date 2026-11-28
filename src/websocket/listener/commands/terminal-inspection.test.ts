import { expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiRequestError } from "@/backend/api/request";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { removeTestDir } from "@/test-utils/test-fs";
import {
  cloudContext,
  inspectSkillDirectories,
} from "@/websocket/listener/commands/terminal-inspection";

test("a missing skill directory preserves the remaining picker entries", async () => {
  const existing = await mkdtemp(join(tmpdir(), "skill-picker-"));
  const missing = join(existing, "removed");
  try {
    const entries = await inspectSkillDirectories(
      [existing, missing].map((path) => ({
        name: path,
        path: join(path, "SKILL.md"),
        description: "",
      })),
    );
    expect(entries.map((entry) => entry.path)).toEqual([
      await realpath(existing),
      missing,
    ]);
  } finally {
    await removeTestDir(existing);
  }
});

test("missing Cloud context endpoint falls back to a read-only conversation prompt and reported usage", async () => {
  const backend = new FakeHeadlessBackend("agent-context");
  const recompile = spyOn(backend, "recompileConversation").mockResolvedValue(
    "12345678",
  );
  const result = await cloudContext(
    "agent-context",
    "default",
    15,
    async () => {
      throw new ApiRequestError("Not found", 404, "");
    },
    backend,
  );
  expect(recompile).toHaveBeenCalledWith("default", {
    agent_id: "agent-context",
    dry_run: true,
  });
  expect(result).toContain("Last reported context: 15 tokens");
  expect(result).toContain("System and memory (estimated): 2 tokens");
  expect(result).toContain("other input (estimated): 13 tokens");
});
