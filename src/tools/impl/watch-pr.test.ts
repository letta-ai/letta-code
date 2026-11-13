import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPermission } from "@/permissions/checker";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";
import { TOOLSET_CATALOG } from "@/tools/toolset-catalog";
import { setMessageQueueAdder } from "@/utils/message-queue-bridge";
import { GitHubPullRequestSnapshotPending } from "./github-pull-request-cloud";
import type { GitHubPullRequestSnapshot } from "./github-pull-request-types";
import { backgroundProcesses } from "./process_manager";
import { task_stop } from "./task-stop";
import { watch_pr } from "./watch-pr";

const url = "https://github.com/letta-ai/letta-code/pull/42";
let previousManagedCloud: string | undefined;
let previousMonitorMaxTimeout: string | undefined;
beforeEach(() => {
  previousMonitorMaxTimeout = process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS;
  delete process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS;
  previousManagedCloud = process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
});

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
  if (previousMonitorMaxTimeout === undefined)
    delete process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS;
  else
    process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS = previousMonitorMaxTimeout;
  if (previousManagedCloud === undefined)
    delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  else process.env.LETTA_MANAGED_CLOUD_RUNTIME = previousManagedCloud;
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
  test("reports a comment posted between watches in the second initial result", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "watch-pr-resume-"));
    const previousConfigDir = process.env.LETTA_CONFIG_DIR;
    process.env.LETTA_CONFIG_DIR = configDir;
    const args = {
      url,
      parentScope: { agentId: "agent-resume", conversationId: "conv-resume" },
    };
    const wait = async (signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    try {
      const first = await watch_pr(args, {
        fetchSnapshot: async () => snapshot(),
        wait,
      });
      await task_stop({ task_id: first.taskId });
      const second = await watch_pr(args, {
        fetchSnapshot: async () =>
          snapshot({
            comments: [
              {
                id: "between-watches",
                author: "alice",
                body: "Please address this before merging",
                url: "https://github.com/letta-ai/letta-code/pull/42#issuecomment-1",
                updatedAt: "2",
              },
            ],
          }),
        wait,
      });
      await task_stop({ task_id: second.taskId });
      expect(second.content[0]?.text).toContain(
        "Changes since the previous watch ended",
      );
      expect(second.content[0]?.text).toContain(
        "New PR comment from @alice: Please address this before merging",
      );
    } finally {
      if (previousConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
      else process.env.LETTA_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("restarting after a merge-ready poll reports no readiness change", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "watch-pr-readiness-"));
    const previousConfigDir = process.env.LETTA_CONFIG_DIR;
    process.env.LETTA_CONFIG_DIR = configDir;
    const args = {
      url,
      parentScope: { agentId: "agent-ready", conversationId: "conv-ready" },
    };
    let pollFinished!: () => void;
    const polled = new Promise<void>((resolve) => {
      pollFinished = resolve;
    });
    let waits = 0;
    const wait = async (signal: AbortSignal) => {
      if (++waits === 1) return;
      pollFinished();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    try {
      const first = await watch_pr(args, {
        fetchSnapshot: async () => snapshot({ readinessConfirmed: false }),
        wait,
      });
      await polled;
      await task_stop({ task_id: first.taskId });
      const second = await watch_pr(args, {
        fetchSnapshot: async () => snapshot({ readinessConfirmed: false }),
        wait,
      });
      await task_stop({ task_id: second.taskId });
      expect(second.content[0]?.text).not.toContain(
        "PR is no longer merge-ready",
      );
      expect(second.content[0]?.text).not.toContain(
        "Changes since the previous watch ended",
      );
    } finally {
      if (previousConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
      else process.env.LETTA_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("Cloud deadline aborts an in-flight poll and sends one scoped notification", async () => {
    process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
    process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS = "86400";
    const realSetTimeout = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(
      Object.assign(
        (...[callback, ms, ...args]: Parameters<typeof setTimeout>) =>
          realSetTimeout(callback, ms === 86_400_000 ? 50 : ms, ...args),
        { __promisify__: realSetTimeout.__promisify__ },
      ),
    );
    const queued: Array<{
      text: string;
      agentId?: string;
      conversationId?: string;
    }> = [];
    setMessageQueueAdder((message) => queued.push(message));
    let calls = 0;
    let pollSignal: AbortSignal | undefined;
    try {
      const result = await watch_pr(
        {
          url,
          parentScope: { agentId: "agent-cloud", conversationId: "conv-cloud" },
        },
        {
          wait: async () => {},
          fetchSnapshot: async (_ref, { signal }) => {
            if (++calls === 1) return snapshot();
            pollSignal = signal;
            return new Promise((_resolve, reject) =>
              signal?.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              ),
            );
          },
        },
      );
      expect(result.persistent).toBe(false);
      expect(result.content[0]?.text).toContain("24-hour");
      await Bun.sleep(150);
      expect(pollSignal?.aborted).toBe(true);
      expect(backgroundProcesses.get(result.taskId)?.status).toBe("failed");
      expect(calls).toBe(2);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        agentId: "agent-cloud",
        conversationId: "conv-cloud",
      });
      expect(queued[0]?.text).toContain("24-hour Cloud sandbox limit");
      expect(queued[0]?.text).toContain("re-arm it by calling WatchPR again");
      expect(queued[0]?.text).toContain("Wake or cron");
    } finally {
      timers.mockRestore();
    }
  });

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
    expect(result.persistent).toBe(true);
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

  test("does not start a background watch when its output file cannot be written", async () => {
    await expect(
      watch_pr(
        { url },
        {
          fetchSnapshot: async () => snapshot(),
          createOutputWriter: () => ({ append: () => false }),
        },
      ),
    ).rejects.toThrow("could not write its output file");
    expect(backgroundProcesses.size).toBe(0);
  });

  test("keeps short alternating cooldown failures and recoveries silent", async () => {
    let now = 0;
    let fetchCount = 0;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const queued: string[] = [];
    setMessageQueueAdder((message) => queued.push(message.text));
    const result = await watch_pr(
      { url },
      {
        now: () => now,
        fetchSnapshot: async () => {
          if (++fetchCount % 2 === 0) {
            throw new Error("Cloud PR snapshot is still cooling down");
          }
          return snapshot();
        },
        wait: async (signal, milliseconds) => {
          if (fetchCount >= 13) {
            finish();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          }
          now += milliseconds;
        },
      },
    );
    await finished;
    await Bun.sleep(250);
    await task_stop({ task_id: result.taskId });
    expect(queued).toEqual([]);
    const outputFile = backgroundProcesses.get(result.taskId)?.outputFile;
    expect(outputFile).toBeDefined();
    expect(
      readFileSync(outputFile!, "utf8").match(/\[poll error 1\]/g),
    ).toHaveLength(6);
  });

  for (const pendingMinutes of [20, 35]) {
    test(`${pendingMinutes} minutes of pending polls only reports prolonged silence and its recovery`, async () => {
      let now = 0;
      let fetchCount = 0;
      let output = "";
      const queued: string[] = [];
      const waits: number[] = [];
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      setMessageQueueAdder((message) => queued.push(message.text));
      const result = await watch_pr(
        { url },
        {
          now: () => now,
          createOutputWriter: () => ({
            append: (text) => {
              output += text;
              return true;
            },
          }),
          fetchSnapshot: async () => {
            fetchCount++;
            if (fetchCount > 1 && now <= pendingMinutes * 60_000) {
              throw new GitHubPullRequestSnapshotPending();
            }
            return snapshot();
          },
          wait: async (signal, milliseconds) => {
            if (now > pendingMinutes * 60_000) {
              finish();
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              });
            }
            waits.push(milliseconds);
            now += milliseconds;
          },
        },
      );
      await finished;
      await Bun.sleep(250);
      await task_stop({ task_id: result.taskId });
      expect(waits.every((ms) => ms === 30_000)).toBe(true);
      expect(output).toContain("[poll pending]");
      expect(output).not.toContain("[poll error");
      expect(output).not.toContain("could not refresh");
      expect(output).not.toContain("recovered after");
      if (pendingMinutes === 20) {
        expect(queued).toEqual([]);
        expect(output).not.toContain("WatchPR hasn't received");
        expect(output).not.toContain("receiving PR updates again");
      } else {
        expect(
          output.match(
            /WatchPR hasn't received fresh PR data for 30 minutes; still watching\./g,
          ),
        ).toHaveLength(1);
        expect(
          output.match(/WatchPR is receiving PR updates again\./g),
        ).toHaveLength(1);
        expect(queued.join("\n")).toContain("still watching.");
        expect(queued.join("\n")).toContain("receiving PR updates again.");
      }
    });
  }

  test("reports a sustained refresh error once and reports recovery", async () => {
    let now = 0;
    let fetchCount = 0;
    const waits: number[] = [];
    let output = "";
    let earlyOutput = "";
    const queued: string[] = [];
    setMessageQueueAdder((message) => queued.push(message.text));

    const result = await watch_pr(
      { url },
      {
        now: () => now,
        createOutputWriter: () => ({
          append: (text) => {
            output += text;
            return true;
          },
        }),
        fetchSnapshot: async () => {
          fetchCount += 1;
          if (fetchCount >= 2 && fetchCount <= 6) {
            throw new Error("GitHub temporarily unavailable");
          }
          return fetchCount >= 8 ? snapshot({ state: "MERGED" }) : snapshot();
        },
        wait: async (_signal, milliseconds) => {
          if (waits.length === 3) earlyOutput = output;
          now += milliseconds;
          waits.push(milliseconds);
          if (waits.length > 8) throw new Error("test loop escaped");
        },
      },
    );

    await Bun.sleep(250);
    expect(earlyOutput).not.toContain("could not refresh");
    const notifications = queued.join("\n");
    expect(
      queued.filter((notification) =>
        notification.includes("could not refresh"),
      ),
    ).toHaveLength(1);
    expect(notifications).toContain("recovered after 5 failed polls");
    expect(output.match(/WatchPR could not refresh/g)).toHaveLength(1);
    expect(output.match(/WatchPR recovered/g)).toHaveLength(1);
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
