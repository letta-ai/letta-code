import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Letta } from "@letta-ai/letta-client";
import { ArrayPage } from "@letta-ai/letta-client/core/pagination";
import type { Backend } from "@/backend";
import { runMessagesSubcommand } from "./messages";

type Page = Awaited<ReturnType<Backend["listConversationMessages"]>>;
const client = new Letta({ apiKey: "test-only" });
function page(items: Page["items"]): Page {
  return new ArrayPage(client, new Response(), items, {
    method: "get",
    path: "/test",
  });
}
let pages: Page[];
const listConversationMessages = mock(
  async (..._args: Parameters<Backend["listConversationMessages"]>) =>
    pages.shift() ?? page([]),
);
const listAgentMessages = mock(
  async (..._args: Parameters<Backend["listAgentMessages"]>) =>
    pages.shift() ?? page([]),
);
const message = {
  id: "message-1",
  message_type: "assistant_message" as const,
  content: "failed step output",
  step_id: "step-failed",
  date: "2026-09-01T12:00:00Z",
};
let stdout: string[];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  pages = [];
  stdout = [];
  logSpy = spyOn(console, "log").mockImplementation((value) => {
    stdout.push(String(value));
  });
  listConversationMessages.mockClear();
  listAgentMessages.mockClear();
});
afterEach(() => logSpy.mockRestore());

async function run(action: string, args: string[]) {
  const code = await runMessagesSubcommand(
    [action, "--agent", "agent-target", ...args],
    {
      initializeSettings: async () => {},
      getBackend: () => ({ listConversationMessages, listAgentMessages }),
    },
  );
  expect(code).toBe(0);
  return JSON.parse(stdout[0] ?? "");
}

test.each(["default", "conv-target"])(
  "includes failed-step messages and preserves correlation IDs for %s",
  async (conversation) => {
    const earlier = {
      ...message,
      id: "message-earlier",
      date: "2026-09-01T11:00:00Z",
    };
    pages.push(page([message, earlier]));
    expect(
      await run("list", ["--conversation", conversation, "--include-errors"]),
    ).toEqual([earlier, message]);
    const query =
      conversation === "default" ? listAgentMessages : listConversationMessages;
    expect(query.mock.calls[0]?.[1]).toMatchObject({ include_err: true });
  },
);

test("does not change the default failed-step filter", async () => {
  await run("list", ["--conversation", "conv-target"]);
  expect(listConversationMessages.mock.calls[0]?.[1]).not.toHaveProperty(
    "include_err",
  );
});

test.each(["stdout", "--out", "--output"])(
  "bounded export to %s reports truncation and includes failed steps on every page",
  async (destination) => {
    const directory = mkdtempSync(join(tmpdir(), "messages-export-"));
    const outputPath = join(directory, "transcript.txt");
    try {
      pages.push(page([message]), page([{ ...message, id: "message-2" }]));
      const result = await run("transcript", [
        "--conversation",
        "default",
        "--include-errors",
        "--limit",
        "1",
        "--max-pages",
        "2",
        ...(destination === "stdout" ? [] : [destination, outputPath]),
      ]);
      expect(result).toMatchObject({
        conversation_id: "default",
        agent_id: "agent-target",
        truncated: true,
        message_count: 2,
      });
      if (destination === "stdout") {
        expect(result.transcript).toContain(message.content);
        expect(result).not.toHaveProperty("output_path");
      } else {
        expect(result.output_path).toBe(outputPath);
        expect(result).not.toHaveProperty("transcript");
        expect(readFileSync(outputPath, "utf8")).toContain(message.content);
      }
      expect(listConversationMessages.mock.calls[1]).toEqual([
        "default",
        {
          limit: 1,
          order: "desc",
          include_err: true,
          agent_id: "agent-target",
          before: "message-1",
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each(["empty", "partial"])(
  "reports complete only after observing a terminal %s page",
  async (terminal) => {
    pages.push(page(terminal === "empty" ? [] : [message]));
    const result = await run("transcript", [
      "--conversation",
      "conv-target",
      "--limit",
      "2",
      "--max-pages",
      "1",
    ]);
    expect(result.truncated).toBe(false);
  },
);

test("repeated pages stop without claiming complete coverage or duplicating messages", async () => {
  pages.push(page([message]), page([message]));
  const result = await run("transcript", [
    "--conversation",
    "conv-target",
    "--limit",
    "1",
  ]);
  expect(result.truncated).toBe(true);
  expect(result.message_count).toBe(1);
  expect(listConversationMessages).toHaveBeenCalledTimes(2);
});
