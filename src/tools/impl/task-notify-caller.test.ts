import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAllSubagents,
  getSnapshot as getSubagentSnapshot,
} from "@/agent/subagent-state";
import { __resetCodexSessionsForTests } from "@/tools/impl/codex-app-server";
import {
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { backgroundTasks } from "./process_manager";
import { launchSubagent, spawnBackgroundSubagentTask } from "./task";

// These launches run on the computer that received `notify: "caller"`.
const parentScope = { agentId: "agent-parent", conversationId: "conv-parent" };
const queued: QueuedMessage[] = [];
let bin: string;
const originalPath = process.env.PATH;
// Fake CLIs are shebang scripts, which Windows cannot execute from PATH.
const isWindows = process.platform === "win32";

function fakeExecutable(name: string, source: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!${process.execPath}\n${source}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "notify-caller-bin-"));
  // Keep system tools such as systemd-run, but no real claude/codex.
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  setMessageQueueAdder((message) => queued.push(message));
});

afterEach(() => {
  process.env.PATH = originalPath;
  setMessageQueueAdder(null);
  queued.length = 0;
  rmSync(bin, { recursive: true, force: true });
  backgroundTasks.clear();
  clearAllSubagents();
  __resetCodexSessionsForTests();
});

function launch(type: "claude-code" | "codex") {
  return launchSubagent({
    subagent_type: type,
    prompt: "Fix the bug",
    description: "Fix the bug",
    mcp: { inherit: false },
    toolCallId: "call-1",
    parentScope,
    notifyCaller: true,
  });
}

describe("notify caller on the launching computer", () => {
  test("publishes the final report on the snapshot instead of notifying itself", async () => {
    const { taskId, subagentId } = spawnBackgroundSubagentTask({
      subagentType: "claude-code",
      prompt: "Fix the bug",
      description: "Fix the bug",
      toolCallId: "call-1",
      parentScope,
      emitCompletionNotification: false,
      publishResult: true,
      deps: {
        spawnSubagentImpl: async () => ({
          agentId: "claude_session",
          report: "Fixed it",
          success: true,
        }),
        copyGitHubPullRequestTagsImpl: async () => {},
      },
    });
    await backgroundTasks.get(taskId)?.completion;
    for (let i = 0; i < 100; i++) {
      const entry = getSubagentSnapshot().agents.find(
        (agent) => agent.id === subagentId,
      );
      if (entry?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      getSubagentSnapshot().agents.find((agent) => agent.id === subagentId),
    ).toMatchObject({
      status: "completed",
      result: "Fixed it",
      toolCallId: "call-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queued).toHaveLength(0);
  });

  test.each(["claude-code", "codex"] as const)(
    "fails a %s launch whose CLI is not installed",
    async (type) => {
      const result = await launch(type);
      expect(result).toMatchObject({
        success: false,
        error_code: "not_installed",
      });
      expect(queued).toHaveLength(0);
    },
  );

  test.skipIf(isWindows)(
    "fails a Claude Code launch that is not signed in",
    async () => {
      fakeExecutable(
        "claude",
        `process.stdout.write(JSON.stringify({ loggedIn: false })); process.exit(1);`,
      );
      expect(await launch("claude-code")).toMatchObject({
        success: false,
        error_code: "not_signed_in",
      });
      expect(queued).toHaveLength(0);
    },
  );

  test.skipIf(isWindows)(
    "fails a Codex launch whose app-server needs an OpenAI sign-in",
    async () => {
      fakeExecutable(
        "codex",
        `if (process.argv[2] === "--version") { console.log("codex-cli 0.0.0"); process.exit(0); }
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (typeof request.id !== "number") return;
  const result = request.method === "account/read"
    ? { account: null, requiresOpenaiAuth: true }
    : request.method === "thread/start" ? { thread: { id: "thread-1" } } : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});`,
      );
      expect(await launch("codex")).toMatchObject({
        success: false,
        error_code: "not_signed_in",
      });
      expect(queued).toHaveLength(0);
    },
  );
});
