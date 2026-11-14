import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";
import {
  getCurrentWorkingDirectory,
  getRuntimeActingUserAttribution,
  getRuntimeContext,
} from "@/runtime-context";
import { scrubSecretsFromString } from "@/tools/secret-substitution";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import { resolveNotificationScope } from "@/utils/task-notifications";
import {
  createGitHubPullRequestSnapshotFetcher,
  GitHubPullRequestSnapshotPending,
} from "./github-pull-request-cloud";
import {
  diffGitHubPullRequestSnapshots,
  type PullRequestEventKind,
} from "./github-pull-request-diff";
import {
  describeGitHubPullRequestSnapshot,
  hasGitHubPullRequestReadyConditions,
} from "./github-pull-request-state";
import type {
  GitHubPullRequestRef,
  GitHubPullRequestSnapshot,
} from "./github-pull-request-types";
import { parseGitHubPullRequestUrl } from "./github-pull-request-watch";
import {
  createGitHubWorkflowRunFetcher,
  describeWorkflowRun,
  parseGitHubWorkflowRunUrl,
} from "./github-workflow-run";
import {
  getMonitorTimeoutEvent,
  installMonitorProcessExitCleanup,
  MonitorOutputWriter,
  markMonitorFinished,
  queueMonitorEvent,
} from "./monitor";
import {
  createMonitorEventStream,
  MONITOR_EVENT_BATCH_CHARS,
  MONITOR_EVENT_LINE_CHARS,
} from "./monitor-event-stream";
import { withMonitorState } from "./monitor-state";
import { getMonitorMaxTimeoutMs } from "./monitor-timeout";
import {
  assertBackgroundProcessCapacity,
  type BackgroundProcess,
  backgroundProcesses,
  createBackgroundOutputFile,
  notifyBackgroundProcessStateChanged,
  unrefTimer,
} from "./process_manager";

const WATCH_POLL_MS = 30_000;
const WATCH_MAX_POLL_MS = 5 * 60_000;
const WATCH_REFRESH_ERROR_NOTIFY_AFTER_MS = 5 * 60_000;
const WATCH_FRESH_SNAPSHOT_NOTIFY_AFTER_MS = 30 * 60_000;

interface WatchPullRequestArgs {
  url: string;
  notify_on?: PullRequestEventKind[];
  parentScope?: { agentId: string; conversationId: string };
  signal?: AbortSignal;
}

interface WatchPullRequestResult {
  content: Array<{ type: "text"; text: string }>;
  taskId: string;
  url: string;
  headSha: string;
  persistent: boolean;
}

interface WatchPullRequestDeps {
  fetchSnapshot?: (
    ref: GitHubPullRequestRef,
    options: { cwd: string; signal?: AbortSignal },
  ) => Promise<GitHubPullRequestSnapshot>;
  now?: () => number;
  wait?: (signal: AbortSignal, milliseconds: number) => Promise<void>;
  createOutputWriter?: (path: string) => { append(text: string): boolean };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return scrubSecretsFromString(message, {})
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function pollDelayMs(failedPolls: number): number {
  return Math.min(WATCH_POLL_MS * 2 ** failedPolls, WATCH_MAX_POLL_MS);
}

async function defaultWait(
  signal: AbortSignal,
  milliseconds: number,
): Promise<void> {
  await delay(milliseconds, undefined, { signal });
}

// Cache failures must never prevent a watch from starting or polling.
function saveSnapshot(
  path: string | undefined,
  snapshot: GitHubPullRequestSnapshot,
): void {
  if (!path) return;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (snapshot.state !== "OPEN") {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    // Previous discussion bodies and authors are not needed by the diff.
    const compact = {
      ...snapshot,
      ref: undefined,
      readinessConfirmed: false,
      checks: snapshot.checks.map(({ key, phase }) => ({ key, phase })),
      checkAttempts: snapshot.checkAttempts.map(({ key }) => ({ key })),
      comments: snapshot.comments.map(({ id, updatedAt }) => ({
        id,
        updatedAt,
      })),
      reviews: snapshot.reviews.map(({ id, updatedAt, state }) => ({
        id,
        updatedAt,
        state,
      })),
      reviewThreads: snapshot.reviewThreads.map(
        ({ id, isResolved, comments }) => ({
          id,
          isResolved,
          comments: comments.map(({ id, updatedAt, outdated }) => ({
            id,
            updatedAt,
            outdated,
          })),
        }),
      ),
    };
    writeFileSync(
      temporary,
      JSON.stringify({ savedAt: Date.now(), snapshot: compact }),
      { mode: 0o600 },
    );
    renameSync(temporary, path);
  } catch {
    // Best effort: GitHub remains the source of truth.
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* Best effort cleanup. */
    }
  }
}

function resumedChanges(
  path: string | undefined,
  initial: GitHubPullRequestSnapshot,
  notifyOn?: readonly PullRequestEventKind[],
): string {
  if (!path) return "";
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const age = Date.now() - saved.savedAt;
    if (!Number.isFinite(age) || age < 0 || age > 7 * 24 * 3_600_000) return "";
    const changes = diffGitHubPullRequestSnapshots(
      saved.snapshot,
      initial,
      notifyOn,
    ).events;
    if (!changes.length) return "";
    // Use the same line and notification limits as live monitor events.
    let text = changes
      .map((line) =>
        line.length > MONITOR_EVENT_LINE_CHARS
          ? `${line.slice(0, MONITOR_EVENT_LINE_CHARS)}...(truncated)`
          : line,
      )
      .join("\n");
    if (text.length > MONITOR_EVENT_BATCH_CHARS)
      text = `${text.slice(0, MONITOR_EVENT_BATCH_CHARS)}\n...(truncated)`;
    return `\n\nChanges since the previous watch ended:\n${text}`;
  } catch {
    return "";
  }
}

export async function watch_pr(
  args: WatchPullRequestArgs,
  deps: WatchPullRequestDeps = {},
): Promise<WatchPullRequestResult> {
  args.signal?.throwIfAborted();
  if (typeof args.url !== "string") {
    throw new Error("WatchPR url is required");
  }
  const isRun = args.url.includes("/actions/runs/");
  const ref = isRun
    ? parseGitHubWorkflowRunUrl(args.url)
    : parseGitHubPullRequestUrl(args.url);
  const describe = isRun
    ? describeWorkflowRun
    : describeGitHubPullRequestSnapshot;
  const cwd = getCurrentWorkingDirectory();
  const fetchSnapshot =
    deps.fetchSnapshot ??
    (isRun
      ? createGitHubWorkflowRunFetcher()
      : createGitHubPullRequestSnapshotFetcher());
  const runtimeContext = getRuntimeContext();
  const parentScope =
    args.parentScope ??
    (runtimeContext?.agentId
      ? {
          agentId: runtimeContext.agentId,
          conversationId: runtimeContext.conversationId ?? "default",
        }
      : undefined);
  const scope = resolveNotificationScope(parentScope);
  let snapshotPath: string | undefined;
  try {
    snapshotPath =
      scope && !isRun
        ? join(
            resolveGlobalConfigDir(),
            "cache",
            "watch-pr",
            `${createHash("sha256")
              .update(
                JSON.stringify([
                  scope.agentId,
                  scope.conversationId,
                  ref.owner.toLowerCase(),
                  ref.repo.toLowerCase(),
                  ref.number,
                ]),
              )
              .digest("hex")}.json`,
          )
        : undefined;
  } catch {
    // Invalid config paths disable persistence, not the watch.
  }
  const initial = await fetchSnapshot(ref, { cwd, signal: args.signal });
  args.signal?.throwIfAborted();
  const changesSincePreviousWatch = resumedChanges(
    snapshotPath,
    initial,
    args.notify_on,
  );
  if (isRun && initial.state !== "OPEN") {
    return {
      content: [{ type: "text", text: describe(initial) }],
      taskId: "",
      url: ref.url,
      headSha: initial.headSha,
      persistent: false,
    };
  }
  if (initial.state !== "OPEN") {
    saveSnapshot(snapshotPath, initial);
    throw new Error(
      `WatchPR did not start because ${ref.url} is already ${initial.state.toLowerCase()}.`,
    );
  }

  assertBackgroundProcessCapacity();
  installMonitorProcessExitCleanup();
  const description = isRun
    ? `Workflow run ${ref.owner}/${ref.repo}#${ref.number}`
    : `PR ${ref.owner}/${ref.repo}#${ref.number} checks, reviews, and mergeability`;
  const persistent = !isManagedCloudRuntime();
  return withMonitorState<WatchPullRequestResult>(
    {
      description,
      persistent,
      command: ref.url,
      kind: "github_pull_request",
      parentScope,
      signal: args.signal,
    },
    (taskId) => {
      const outputFile = createBackgroundOutputFile(taskId);
      const output =
        deps.createOutputWriter?.(outputFile) ??
        new MonitorOutputWriter(outputFile);
      if (
        !output.append(
          `[initial snapshot]\n${describe(initial)}${changesSincePreviousWatch}\n`,
        )
      ) {
        rmSync(outputFile, { force: true });
        throw new Error(
          `WatchPR could not write its output file: ${outputFile}`,
        );
      }
      saveSnapshot(snapshotPath, initial);
      const actingUserId = getRuntimeActingUserAttribution();
      const controller = new AbortController();
      const secrets: Readonly<Record<string, string>> = {};
      let processState: BackgroundProcess;
      const maxTimeoutMs = getMonitorMaxTimeoutMs();
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const events = createMonitorEventStream({
        emit(event) {
          queueMonitorEvent({
            taskId,
            event,
            scope,
            actingUserId,
            secrets,
          });
        },
        stopSource() {
          if (!processState || processState.status !== "running") return;
          processState.completionNotificationSuppressed = true;
          output.append("\n[stopped: output rate too high]\n");
          markMonitorFinished(taskId, processState, "failed", null);
          controller.abort();
        },
      });

      const emit = (lines: readonly string[]): void => {
        if (lines.length === 0 || processState.status !== "running") return;
        const text = scrubSecretsFromString(`${lines.join("\n")}\n`, {});
        if (!output.append(text)) {
          processState.completionNotificationSuppressed = true;
          markMonitorFinished(taskId, processState, "failed", null);
          controller.abort();
          return;
        }
        events.onData(text);
      };

      processState = {
        process: {
          kill() {
            clearTimeout(timeout);
            events.cancel();
            controller.abort();
          },
        },
        command: ref.url,
        status: "running",
        exitCode: null,
        startTime: new Date(),
        outputFile,
        runtimeScope: scope,
        actingUserId,
        kind: "monitor",
        description,
        monitorSource: "github_pull_request",
        persistent,
        secrets,
      };
      backgroundProcesses.set(taskId, processState);
      notifyBackgroundProcessStateChanged(scope);

      if (!persistent) {
        timeout = setTimeout(() => {
          if (processState.status !== "running") return;
          events.finish();
          if (processState.status !== "running") return;
          const event = getMonitorTimeoutEvent(maxTimeoutMs, "WatchPR");
          output.append(`\n${event}\n`);
          queueMonitorEvent({ taskId, event, scope, actingUserId, secrets });
          processState.completionNotificationSuppressed = true;
          markMonitorFinished(taskId, processState, "failed", null);
          processState.process.kill();
        }, maxTimeoutMs);
        unrefTimer(timeout);
      }

      const wait = deps.wait ?? defaultWait;
      const now = deps.now ?? Date.now;
      void (async () => {
        let previous = initial;
        let lastFreshSnapshotAt = now();
        let freshnessNoticeSent = false;
        let nextPollMs = WATCH_POLL_MS;
        let failedPolls = 0;
        let failureStartedAt: number | undefined;
        let lastNotifiedError: string | undefined;
        while (processState.status === "running") {
          try {
            await wait(controller.signal, nextPollMs);
            if (processState.status !== "running") return;
            const current = await fetchSnapshot(ref, {
              cwd,
              signal: controller.signal,
            });
            if (processState.status !== "running") return;
            lastFreshSnapshotAt = now();
            if (freshnessNoticeSent) {
              emit(["WatchPR is receiving PR updates again."]);
              freshnessNoticeSent = false;
            }
            nextPollMs = WATCH_POLL_MS;
            if (lastNotifiedError !== undefined) {
              emit([
                `WatchPR recovered after ${failedPolls} failed poll${failedPolls === 1 ? "" : "s"}.`,
              ]);
            }
            failedPolls = 0;
            failureStartedAt = undefined;
            lastNotifiedError = undefined;
            const sameHead = current.headSha === previous.headSha;
            const stableCurrent = { ...current, readinessConfirmed: false };
            stableCurrent.readinessConfirmed = Boolean(
              sameHead &&
                hasGitHubPullRequestReadyConditions(previous) &&
                hasGitHubPullRequestReadyConditions(stableCurrent),
            );
            saveSnapshot(snapshotPath, stableCurrent);
            const diff = isRun
              ? {
                  events:
                    previous.workflowRun?.status !==
                      current.workflowRun?.status ||
                    previous.workflowRun?.conclusion !==
                      current.workflowRun?.conclusion
                      ? [describe(current)]
                      : [],
                  terminal: current.state !== "OPEN",
                }
              : diffGitHubPullRequestSnapshots(
                  previous,
                  stableCurrent,
                  args.notify_on,
                );
            emit(diff.events);
            previous = stableCurrent;
            if (diff.terminal) {
              events.finish();
              if (processState.status === "running") {
                markMonitorFinished(taskId, processState, "completed", 0);
              }
              return;
            }
          } catch (error) {
            if (
              controller.signal.aborted ||
              processState.status !== "running"
            ) {
              return;
            }
            if (
              !freshnessNoticeSent &&
              now() - lastFreshSnapshotAt >=
                WATCH_FRESH_SNAPSHOT_NOTIFY_AFTER_MS
            ) {
              emit([
                "WatchPR hasn't received fresh PR data for 30 minutes; still watching.",
              ]);
              freshnessNoticeSent = true;
            }
            if (error instanceof GitHubPullRequestSnapshotPending) {
              nextPollMs = WATCH_POLL_MS;
              if (
                !output.append("[poll pending] Waiting for fresh PR data\n")
              ) {
                processState.completionNotificationSuppressed = true;
                markMonitorFinished(taskId, processState, "failed", null);
                controller.abort();
                return;
              }
              continue;
            }
            failedPolls += 1;
            nextPollMs = pollDelayMs(failedPolls);
            failureStartedAt ??= now();
            const message = errorText(error);
            if (!output.append(`[poll error ${failedPolls}] ${message}\n`)) {
              processState.completionNotificationSuppressed = true;
              markMonitorFinished(taskId, processState, "failed", null);
              controller.abort();
              return;
            }
            if (
              now() - failureStartedAt >= WATCH_REFRESH_ERROR_NOTIFY_AFTER_MS &&
              message !== lastNotifiedError
            ) {
              emit([
                `WatchPR could not refresh ${ref.url}: ${message}. Retrying.`,
              ]);
              lastNotifiedError = message;
            }
          }
        }
      })()
        .catch((error: unknown) => {
          if (processState.status !== "running") return;
          emit([
            `WatchPR stopped after an unexpected error: ${errorText(error)}`,
          ]);
          events.finish();
          if (processState.status === "running") {
            markMonitorFinished(taskId, processState, "failed", null);
          }
        })
        .finally(() => clearTimeout(timeout));

      return {
        content: [
          {
            type: "text",
            text: isRun
              ? `WatchPR started (task ${taskId}). It reports workflow run status changes and completion with conclusion and failed jobs/steps.\n\n${describe(initial)}\n\nOutput file: ${outputFile}`
              : `WatchPR started (task ${taskId}). ${args.notify_on ? `It will report ${args.notify_on.join(", ")} and watcher errors.` : "It will keep watching after CI finishes and report new failures, reviews, comments, conflicts, head changes, merge-state changes, and watcher errors."} It stops when the PR merges/closes, on TaskStop, or when this session ends.${persistent ? "" : ` A hard ${maxTimeoutMs / 3_600_000}-hour limit applies in this Cloud sandbox; call WatchPR again to re-arm it, or use Wake or cron for much longer waits.`}\n\nCurrent state:\n${describe(initial)}${changesSincePreviousWatch}\n\nOutput file: ${outputFile}`,
          },
        ],
        taskId,
        url: ref.url,
        headSha: initial.headSha,
        persistent,
      };
    },
  );
}
