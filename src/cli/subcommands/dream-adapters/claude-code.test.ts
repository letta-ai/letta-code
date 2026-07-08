import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeAdapter } from "./claude-code";

describe("claudeCodeAdapter.convert", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-source-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("normalizes a Claude Code JSONL session into external transcript entries", async () => {
    const file = join(dir, "session-abc.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-04T09:00:00.000Z",
          cwd: "/repo",
          message: { role: "user", content: "Fix the failing test" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-04T09:00:01.000Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "Done." }],
          },
        }),
      ].join("\n"),
    );

    const entries = await claudeCodeAdapter.convert(file);
    expect(entries).toEqual([
      {
        kind: "user",
        text: "Fix the failing test",
        captured_at: "2026-07-04T09:00:00.000Z",
        source_message_id: "claude:session-abc:1",
      },
      {
        kind: "assistant",
        text: "Done.",
        captured_at: "2026-07-04T09:00:01.000Z",
        source_message_id: "claude:session-abc:2",
      },
    ]);
  });
});
