import { expect, test } from "bun:test";
import type { MonitorState } from "@/backend/api/monitors";
import { runMonitorsSubcommand } from "./monitors";

const fixture: MonitorState = {
  monitor_id: "monitor-1",
  agent_id: "agent-1",
  conversation_id: "conv-test",
  kind: "github_pull_request",
  description: "Saved watch",
  command: "https://github.com/example/repo/pull/1",
  status: "paused",
  persistent: false,
  device_id: null,
  started_at: "2026-11-13T00:00:00.000Z",
  expires_at: "2026-11-14T00:00:00.000Z",
  output_file: null,
  exit_code: null,
  args: { url: "https://github.com/example/repo/pull/1" },
};

test("lists the current conversation and prints a harness tool call without starting work", async () => {
  const previous = process.env.CONVERSATION_ID;
  process.env.CONVERSATION_ID = "conv-test";
  const lines: string[] = [];
  try {
    const deps = {
      initializeSettings: async () => {},
      print: (text: string) => {
        lines.push(text);
      },
      list: async (scope: { conversation_id?: string; status?: string }) => {
        expect(scope).toMatchObject({
          conversation_id: "conv-test",
          status: "paused",
        });
        return [fixture];
      },
      read: async (id: string) => ({ ...fixture, monitor_id: id }),
    };
    expect(
      await runMonitorsSubcommand(
        ["list", "--status", "paused", "--json"],
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(lines[0] ?? "null")).toEqual([fixture]);
    expect(await runMonitorsSubcommand(["resume", "monitor-1"], deps)).toBe(0);
    expect(lines.join("\n")).toContain('WatchPR({"resume":"monitor-1"})');
    expect(lines.join("\n")).toContain("running harness");
  } finally {
    if (previous === undefined) delete process.env.CONVERSATION_ID;
    else process.env.CONVERSATION_ID = previous;
  }
});

test("agent-wide table includes status, dates, command and description", async () => {
  const lines: string[] = [];
  expect(
    await runMonitorsSubcommand(["list", "--agent", "agent-1"], {
      initializeSettings: async () => {},
      print: (text) => {
        lines.push(text);
      },
      list: async (scope) => {
        expect(scope.agent_id).toBe("agent-1");
        expect(scope.conversation_id).toBeUndefined();
        return [fixture];
      },
    }),
  ).toBe(0);
  for (const value of [
    fixture.monitor_id,
    fixture.kind,
    fixture.description,
    fixture.status,
    fixture.started_at,
    fixture.expires_at,
    fixture.command,
  ])
    expect(lines.join("\n")).toContain(value ?? "-");
});
