import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHandsAdapter } from "./openhands";

const USER_MESSAGE_EVENT = {
  kind: "MessageEvent",
  id: "evt-user-1",
  timestamp: "2026-07-04T09:15:23.123456",
  source: "user",
  llm_message: {
    role: "user",
    content: [{ type: "text", text: "Fix the failing test" }],
  },
};

const AGENT_MESSAGE_EVENT = {
  kind: "MessageEvent",
  id: "evt-agent-1",
  timestamp: "2026-07-04T09:16:00.000000",
  source: "agent",
  llm_message: {
    role: "assistant",
    content: [
      { type: "text", text: "Done — the test " },
      { type: "text", text: "passes now." },
    ],
  },
};

const ACTION_EVENT = {
  kind: "ActionEvent",
  id: "evt-action-1",
  timestamp: "2026-07-04T09:15:30.001122",
  source: "agent",
  thought: [{ type: "text", text: "I'll run the tests first." }],
  tool_name: "terminal",
  tool_call_id: "toolu_01ABC",
  tool_call: {
    id: "toolu_01ABC",
    name: "terminal",
    arguments: '{"command": "bun test"}',
  },
  action: { kind: "TerminalAction", command: "bun test" },
};

const OBSERVATION_EVENT = {
  kind: "ObservationEvent",
  id: "evt-obs-1",
  timestamp: "2026-07-04T09:15:35.445566",
  source: "environment",
  tool_name: "terminal",
  tool_call_id: "toolu_01ABC",
  action_id: "evt-action-1",
  observation: {
    kind: "TerminalObservation",
    content: [{ type: "text", text: "1 pass, 0 fail" }],
    is_error: false,
  },
};

describe("openHandsAdapter.convert", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oh-conv-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeEvent(eventsDir: string, seq: string, event: unknown) {
    const id = (event as { id: string }).id;
    await writeFile(
      join(eventsDir, `event-${seq}-${id}.json`),
      JSON.stringify(event),
    );
  }

  test("reads a conversation directory through the normalized trajectory path", async () => {
    const events = join(dir, "conv-abc", "events");
    await mkdir(events, { recursive: true });
    // Write out of filesystem order to prove sequence sorting.
    await writeEvent(events, "00002", AGENT_MESSAGE_EVENT);
    await writeEvent(events, "00000", USER_MESSAGE_EVENT);
    await writeEvent(events, "00001", {
      kind: "SystemPromptEvent",
      id: "evt-sys",
      source: "agent",
    });

    const entries = await openHandsAdapter.convert(join(dir, "conv-abc"));
    expect(entries).toEqual([
      {
        kind: "user",
        text: "Fix the failing test",
        captured_at: "2026-07-04T09:15:23.123Z",
        source_message_id: "openhands:conv-abc:1",
      },
      {
        kind: "assistant",
        text: "Done — the test passes now.",
        captured_at: "2026-07-04T09:16:00.000Z",
        source_message_id: "openhands:conv-abc:2",
      },
    ]);
  });

  test("converts thoughts to reasoning and pairs tool results", async () => {
    const events = join(dir, "events");
    await mkdir(events, { recursive: true });
    await writeEvent(events, "00000", USER_MESSAGE_EVENT);
    await writeEvent(events, "00001", ACTION_EVENT);
    await writeEvent(events, "00002", OBSERVATION_EVENT);
    await writeEvent(events, "00003", AGENT_MESSAGE_EVENT);

    const entries = await openHandsAdapter.convert(events);
    expect(entries).toEqual([
      {
        kind: "user",
        text: "Fix the failing test",
        captured_at: "2026-07-04T09:15:23.123Z",
        source_message_id: `openhands:${dir.split("/").at(-1)}:1`,
      },
      {
        kind: "reasoning",
        text: "I'll run the tests first.",
        captured_at: "2026-07-04T09:15:30.001Z",
        source_message_id: `openhands:${dir.split("/").at(-1)}:2`,
      },
      {
        kind: "tool_call",
        name: "terminal",
        argsText: '{"command": "bun test"}',
        resultText: "1 pass, 0 fail",
        resultOk: true,
        captured_at: "2026-07-04T09:15:30.001Z",
        source_message_id: `openhands:${dir.split("/").at(-1)}:3:tool:0:toolu_01ABC`,
      },
      {
        kind: "assistant",
        text: "Done — the test passes now.",
        captured_at: "2026-07-04T09:16:00.000Z",
        source_message_id: `openhands:${dir.split("/").at(-1)}:5`,
      },
    ]);
  });

  test("discovers every conversation under a store directory", async () => {
    for (const [conversation, message] of [
      ["conv-a", "a"],
      ["conv-b", "b"],
    ] as const) {
      const events = join(dir, conversation, "events");
      await mkdir(events, { recursive: true });
      await writeEvent(events, "00000", {
        ...USER_MESSAGE_EVENT,
        id: `${conversation}-user`,
        llm_message: {
          role: "user",
          content: [{ type: "text", text: message }],
        },
      });
      await writeEvent(events, "00001", {
        ...AGENT_MESSAGE_EVENT,
        id: `${conversation}-agent`,
      });
    }

    const entries = await openHandsAdapter.convert(dir);
    expect(entries.map((entry) => entry.source_message_id)).toEqual([
      "openhands:conv-a:1",
      "openhands:conv-a:2",
      "openhands:conv-b:1",
      "openhands:conv-b:2",
    ]);
  });

  test("errors on a directory with no event files", async () => {
    await expect(openHandsAdapter.convert(dir)).rejects.toThrow(
      "No OpenHands event files",
    );
  });

  test("still reads a single JSON events file", async () => {
    const file = join(dir, "events.json");
    await writeFile(
      file,
      JSON.stringify({ items: [USER_MESSAGE_EVENT, AGENT_MESSAGE_EVENT] }),
    );
    const entries = await openHandsAdapter.convert(file);
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
    expect(entries.map((entry) => entry.source_message_id)).toEqual([
      "openhands:events:1",
      "openhands:events:2",
    ]);
  });
});
