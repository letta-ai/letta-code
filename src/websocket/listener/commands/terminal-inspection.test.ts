import { expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTestDir } from "@/test-utils/test-fs";
import { inspectSkillDirectories } from "@/websocket/listener/commands/terminal-inspection";

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
