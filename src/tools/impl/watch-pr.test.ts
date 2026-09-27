import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { checkPermission } from "@/permissions/checker";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";
import { TOOLSET_CATALOG } from "@/tools/toolset-catalog";
import { setMessageQueueAdder } from "@/utils/message-queue-bridge";
import type { GitHubPullRequestSnapshot } from "./github-pull-request-types";
import { backgroundProcesses } from "./process_manager";
import { task_stop } from "./task-stop";
import { watch_pr } from "./watch-pr";

const url = "https://github.com/letta-ai/letta-code/pull/42";

function snapshot(
  overrides: Partial<GitHubPullRequestSnapshot> = {},
): GitHubPullRequestSnapshot {
  return {
    ref: { owner: "letta-ai", repo: "letta-code", number: 42, url },
    headSha: "a".repeat(40),
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    readinessConfirmed: true,
    checks: [],
    checkAttempts: [],
    comments: [],
    reviews: [],
    reviewThreads: [],
    ...overrides,
  };
}

afterEach(() => {
  setMessageQueueAdder(null);
  for (const process of backgroundProcesses.values()) {
    try {
      process.process.kill("SIGTERM");
    } catch {
      // Already stopped.
    }
    if (process.outputFile && existsSync(process.outputFile)) {
      rmSync(process.outputFile, { force: true });
    }
  }
  backgroundProcesses.clear();
});

describe("WatchPR background lifecycle", () => {
  test("is exposed in every standard toolset as a read-only tool", () => {
    expect(TOOL_DEFINITIONS.WatchPR).toBeDefined();
    expect(TOOLSET_CATALOG.letta.tools).toContain("WatchPR");
    expect(TOOLSET_CATALOG.default.tools).toContain("WatchPR");
    expect(TOOLSET_CATALOG.codex.tools).toContain("WatchPR");
    expect(
      checkPermission(
        "WatchPR",
        { url },
        { allow: [], deny: [], ask: [] },
        "/repo",
      ).decision,
    ).toBe("allow");
    expect(
      checkPermission(
        "WatchPR",
        { url },
        { allow: [], deny: ["WatchPR"], ask: [] },
        "/repo",
      ).decision,
    ).toBe("deny");
  });

  test("returns the initial blockers and emits later review and merge events", async () => {
    const snapshots = [
      snapshot({
        checks: [
          {
            key: "check:tests",
            name: "tests",
            phase: "failure",
            result: "FAILURE",
          },
        ],
      }),
      snapshot({
        comments: [
          {
            id: "comment-1",
            author: "alice",
            body: "please fix this",
            url: "https://comment/1",
            updatedAt: "1",
          },
        ],
      }),
      snapshot({ state: "MERGED" }),
    ];
    const queued: string[] = [];
    setMessageQueueAdder((message) => queued.push(message.text));

    const result = await watch_pr(
      {
        url,
        parentScope: { agentId: "agent-1", conversationId: "conv-1" },
      },
      {
        fetchSnapshot: async () => snapshots.shift() ?? snapshot(),
        wait: async () => {},
      },
    );

    expect(result.content[0]?.text).toContain("Failing checks: tests");
    await Bun.sleep(250);
    expect(queued.join("\n")).toContain("New PR comment from @alice");
    expect(queued.join("\n")).toContain("PR merged");
    expect(backgroundProcesses.get(result.taskId)?.status).toBe("completed");
  });

  test("does not start a background watch for a terminal PR", async () => {
    await expect(
      watch_pr(
        { url },
        { fetchSnapshot: async () => snapshot({ state: "MERGED" }) },
      ),
    ).rejects.toThrow("already merged");
    expect(backgroundProcesses.size).toBe(0);
  });

  test("reports a refresh error once and reports recovery", async () => {
    let fetchCount = 0;
    const waits: number[] = [];
    const queued: string[] = [];
    setMessageQueueAdder((message) => queued.push(message.text));

    const result = await watch_pr(
      { url },
      {
        fetchSnapshot: async () => {
          fetchCount += 1;
          if (fetchCount >= 2 && fetchCount <= 6) {
            throw new Error("GitHub temporarily unavailable");
          }
          return fetchCount >= 8 ? snapshot({ state: "MERGED" }) : snapshot();
        },
        wait: async (_signal, milliseconds) => {
          waits.push(milliseconds);
          if (waits.length > 8) throw new Error("test loop escaped");
        },
      },
    );

    await Bun.sleep(250);
    const notifications = queued.join("\n");
    expect(notifications.match(/could not refresh/g)).toHaveLength(1);
    expect(notifications).toContain("recovered after 5 failed polls");
    expect(waits).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 30_000,
    ]);
    expect(backgroundProcesses.get(result.taskId)?.status).toBe("completed");
  });

  test("requires a second same-head read before announcing readiness", async () => {
    const queued: string[] = [];
    setMessageQueueAdder((message) => queued.push(message.text));
    const snapshots = [
      snapshot({ readinessConfirmed: false }),
      snapshot({ readinessConfirmed: false }),
      snapshot({ state: "MERGED", readinessConfirmed: false }),
    ];

    await watch_pr(
      { url },
      {
        fetchSnapshot: async () => snapshots.shift() ?? snapshot(),
        wait: async () => {},
      },
    );
    await Bun.sleep(250);

    expect(queued.join("\n")).toContain(
      "PR is merge-ready on head aaaaaaaaaaaa after a fresh read",
    );
  });

  test("does not carry old mergeability onto a new head", async () => {
    const queued: string[] = [];
    setMessageQueueAdder((message) => queued.push(message.text));
    const snapshots = [
      snapshot(),
      snapshot({
        headSha: "b".repeat(40),
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
        readinessConfirmed: false,
      }),
      snapshot({
        headSha: "b".repeat(40),
        state: "MERGED",
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
        readinessConfirmed: false,
      }),
    ];

    await watch_pr(
      { url },
      {
        fetchSnapshot: async () => snapshots.shift() ?? snapshot(),
        wait: async () => {},
      },
    );
    await Bun.sleep(250);

    expect(queued.join("\n")).toContain("mergeability still unknown");
    expect(queued.join("\n")).toContain("PR is no longer merge-ready");
  });

  test("TaskStop aborts the watch without a completion notification", async () => {
    let waitStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const result = await watch_pr(
      { url },
      {
        fetchSnapshot: async () => snapshot(),
        wait: async (signal) => {
          waitStarted?.();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      },
    );
    await started;

    await expect(task_stop({ task_id: result.taskId })).resolves.toEqual({
      killed: true,
    });
    expect(backgroundProcesses.get(result.taskId)?.status).toBe("failed");
    await expect(task_stop({ task_id: result.taskId })).resolves.toEqual({
      killed: false,
    });
  });
});
