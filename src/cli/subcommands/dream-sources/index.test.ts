import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRANSCRIPT_ROOT_ENV } from "@/utils/transcript-paths";
import {
  conversationIdForSource,
  type ParsedSource,
  parseFromSource,
  stageFromSource,
} from "./index";

function parseTypedSource(spec: string): ParsedSource {
  const parsed = parseFromSource(spec);
  if (!parsed) throw new Error(`Expected typed source for ${spec}`);
  return parsed;
}

describe("parseFromSource", () => {
  test("returns null for a bare conversation id", () => {
    expect(parseFromSource("conv-123")).toBeNull();
    expect(parseFromSource("default")).toBeNull();
  });

  test("resolves registered typed sources", () => {
    const openhands = parseTypedSource("openhands:/tmp/events.json");
    expect(openhands.adapter.type).toBe("openhands");
    expect(openhands.locator).toBe("/tmp/events.json");

    expect(parseTypedSource("claude:/tmp/session.jsonl").adapter.type).toBe(
      "claude",
    );
    expect(parseTypedSource("codex:/tmp/rollout.jsonl").adapter.type).toBe(
      "codex",
    );
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
    const a = conversationIdForSource(parseTypedSource("openhands:/a.json"));
    const a2 = conversationIdForSource(parseTypedSource("openhands:/a.json"));
    const b = conversationIdForSource(parseTypedSource("openhands:/b.json"));
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
    const parsed = parseTypedSource(`openhands:${eventsPath}`);

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

  test("stages Claude Code sessions through the same idempotent transcript path", async () => {
    const sessionPath = join(root, "session-abc.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-04T10:00:00.000Z",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-04T10:00:01.000Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "ok" }],
          },
        }),
      ].join("\n"),
    );
    const parsed = parseTypedSource(`claude:${sessionPath}`);

    const first = await stageFromSource("agent-1", parsed);
    expect(first.appended).toBe(2);
    expect(first.skipped).toBe(0);

    const second = await stageFromSource("agent-1", parsed);
    expect(second.appended).toBe(0);
    expect(second.skipped).toBe(2);
  });

  test("stages generic transcript JSONL", async () => {
    const rowsPath = join(root, "rows.jsonl");
    await writeFile(
      rowsPath,
      `${JSON.stringify({ kind: "user", text: "hello", source_message_id: "r1" })}\n`,
    );
    const parsed = parseTypedSource(`transcript:${rowsPath}`);
    const result = await stageFromSource("agent-1", parsed);
    expect(result.appended).toBe(1);
  });
});
