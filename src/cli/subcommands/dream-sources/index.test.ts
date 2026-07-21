import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRANSCRIPT_ROOT_ENV } from "@/utils/transcript-paths";
import {
  conversationIdForSource,
  parseFromSource,
  stageFromSource,
} from "./index";

describe("parseFromSource", () => {
  test("returns null for a bare conversation id", () => {
    expect(parseFromSource("conv-123")).toBeNull();
    expect(parseFromSource("default")).toBeNull();
  });

  test("resolves a registered typed source", () => {
    const parsed = parseFromSource("openhands:/tmp/events.json");
    expect(parsed?.adapter.type).toBe("openhands");
    expect(parsed?.locator).toBe("/tmp/events.json");
  });

  test("errors on an unknown source type", () => {
    expect(() => parseFromSource("github:letta-ai/x")).toThrow(
      'Unknown source type "github"',
    );
  });

  test("errors on a typed source missing a locator", () => {
    expect(() => parseFromSource("openhands:")).toThrow("missing path");
  });
});

describe("conversationIdForSource", () => {
  test("is stable for the same spec and differs across specs", () => {
    const a = conversationIdForSource(parseFromSource("openhands:/a.json")!);
    const a2 = conversationIdForSource(parseFromSource("openhands:/a.json")!);
    const b = conversationIdForSource(parseFromSource("openhands:/b.json")!);
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(a.startsWith("from-openhands-")).toBe(true);
  });
});

describe("stageFromSource", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dream-from-test-"));
    process.env[TRANSCRIPT_ROOT_ENV] = root;
  });

  afterEach(async () => {
    delete process.env[TRANSCRIPT_ROOT_ENV];
    await rm(root, { recursive: true, force: true });
  });

  test("stages openhands events and is idempotent on re-ingestion", async () => {
    const eventsPath = join(root, "events.json");
    await writeFile(
      eventsPath,
      JSON.stringify({
        items: [
          {
            kind: "MessageEvent",
            id: "e1",
            timestamp: "2026-07-04T10:00:00.000000",
            source: "user",
            llm_message: {
              role: "user",
              content: [{ type: "text", text: "hi" }],
            },
          },
          {
            kind: "MessageEvent",
            id: "e2",
            timestamp: "2026-07-04T10:00:01.000000",
            source: "agent",
            llm_message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          },
        ],
      }),
    );
    const parsed = parseFromSource(`openhands:${eventsPath}`)!;

    const first = await stageFromSource("agent-1", parsed);
    expect(first.appended).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.conversationId).toBe(conversationIdForSource(parsed));

    const second = await stageFromSource("agent-1", parsed);
    expect(second.appended).toBe(0);
    expect(second.skipped).toBe(2);

    const transcript = await readFile(
      join(root, "agent-1", first.conversationId, "transcript.jsonl"),
      "utf-8",
    );
    const rows = transcript
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0].source_message_id).toBe("e1");
  });

  test("stages generic transcript JSONL", async () => {
    const rowsPath = join(root, "rows.jsonl");
    await writeFile(
      rowsPath,
      `${JSON.stringify({ kind: "user", text: "hello", source_message_id: "r1" })}\n`,
    );
    const parsed = parseFromSource(`transcript:${rowsPath}`)!;
    const result = await stageFromSource("agent-1", parsed);
    expect(result.appended).toBe(1);
  });
});
