import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLettaSource } from "./letta";

const AGENT_ID = "agent-1234";

function row(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function transcriptJsonl(): string {
  return (
    row({
      kind: "user",
      text: "please fix the flaky test",
      captured_at: "2026-07-01T09:00:00Z",
    }) +
    row({
      kind: "reasoning",
      text: "The test races on the port.",
      captured_at: "2026-07-01T09:00:05Z",
    }) +
    row({
      kind: "tool_call",
      name: "Bash",
      argsText: '{"command":"bun test"}',
      resultText: "1 fail",
      resultOk: false,
      captured_at: "2026-07-01T09:00:10Z",
    }) +
    row({
      kind: "assistant",
      text: "Fixed by pinning the port.",
      captured_at: "2026-07-01T09:01:00Z",
    }) +
    "not json\n"
  );
}

describe("letta trajectory source", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "letta-source-"));
    const convDir = join(root, AGENT_ID, "default");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "transcript.jsonl"), transcriptJsonl());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("discovers one session per conversation locator", async () => {
    const source = createLettaSource(root);
    const sessions = await source.discover(`${AGENT_ID}/default`);
    expect(sessions.length).toBe(1);
    const session = sessions[0];
    expect(session?.harness).toBe("letta");
    expect(session?.sessionId).toBe(`${AGENT_ID}/default`);
    expect(session?.startTime).toBe("2026-07-01T09:00:00Z");
    expect(session?.endTime).toBe("2026-07-01T09:01:00Z");
    expect(session?.recordCount).toBe(4);
  });

  test("normalizes transcript rows into normalized-v1", async () => {
    const source = createLettaSource(root);
    const [session] = await source.discover(`${AGENT_ID}/default`);
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);
    const meta = records[0];
    expect(meta?.role).toBe("meta");
    expect(meta?.source).toBe("letta");
    const body = records.filter((r) => r.role !== "meta");
    expect(body.map((r) => r.role)).toEqual([
      "user",
      "reasoning",
      "assistant",
      "tool",
      "assistant",
    ]);
    const toolResult = body.find((r) => r.role === "tool");
    expect(toolResult?.content).toMatch(/^Error: 1 fail/);
  });

  test("requires a locator and an existing transcript", async () => {
    const source = createLettaSource(root);
    await expect(source.discover()).rejects.toThrow(/needs a locator/);
    await expect(source.discover(`${AGENT_ID}/missing`)).rejects.toThrow(
      /No recorded transcript/,
    );
    await expect(source.discover("garbage")).rejects.toThrow(
      /expected <agent-id>\/<conversation-id>/,
    );
  });
});
