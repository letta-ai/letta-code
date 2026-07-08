import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter } from "./codex";

describe("codexAdapter.convert", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codex-source-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("normalizes a Codex rollout into external transcript entries", async () => {
    const file = join(dir, "rollout-2026-07-04T09-00-00-abc.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-04T09:00:00.000Z",
          payload: { cwd: "/repo", timestamp: "2026-07-04T09:00:00.000Z" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-04T09:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fix the failing test" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-04T09:00:02.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done." }],
          },
        }),
      ].join("\n"),
    );

    const entries = await codexAdapter.convert(file);
    expect(entries).toEqual([
      {
        kind: "user",
        text: "Fix the failing test",
        captured_at: "2026-07-04T09:00:01.000Z",
        source_message_id: "codex:2026-07-04T09-00-00-abc:1",
      },
      {
        kind: "assistant",
        text: "Done.",
        captured_at: "2026-07-04T09:00:02.000Z",
        source_message_id: "codex:2026-07-04T09-00-00-abc:2",
      },
    ]);
  });
});
