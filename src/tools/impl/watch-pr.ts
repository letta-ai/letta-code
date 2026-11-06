import { createHash } from "node:crypto";
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
import { diffGitHubPullRequestSnapshots } from "./github-pull-request-diff";
import {
  describeGitHubPullRequestSnapshot,
  hasGitHubPullRequestReadyConditions,
} from "./github-pull-request-state";
import type {
  GitHubPullRequestRef,
  GitHubPullRequestSnapshot,
} from "./github-pull-request-types";
import {
  fetchGitHubPullRequestSnapshot,
  parseGitHubPullRequestUrl,
} from "./github-pull-request-watch";
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
import { getMonitorMaxTimeoutMs } from "./monitor-timeout";
import {
  assertBackgroundProcessCapacity,
  type BackgroundProcess,
  backgroundProcesses,
  createBackgroundOutputFile,
  getNextMonitorId,
  notifyBackgroundProcessStateChanged,
  unrefTimer,
} from "./process_manager";

const WATCH_POLL_MS = 30_000;
const WATCH_MAX_POLL_MS = 5 * 60_000;

interface WatchPullRequestArgs {
  url: string;
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
  const temporary = `${path}.${process.pid}.tmp`;
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
): string {
  if (!path) return "";
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const age = Date.now() - saved.savedAt;
    if (!Number.isFinite(age) || age < 0 || age > 7 * 24 * 3_600_000) return "";
    const changes = diffGitHubPullRequestSnapshots(
      saved.snapshot,
      initial,
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
  const ref = parseGitHubPullRequestUrl(args.url);
  const cwd = getCurrentWorkingDirectory();
  const fetchSnapshot =
    deps.fetchSnapshot ??
    ((pullRequestRef, options) =>
      fetchGitHubPullRequestSnapshot(pullRequestRef, options));
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
  const snapshotPath = scope
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
  const initial = await fetchSnapshot(ref, { cwd, signal: args.signal });
  args.signal?.throwIfAborted();
  const changesSincePreviousWatch = resumedChanges(snapshotPath, initial);
  if (initial.state !== "OPEN") {
    saveSnapshot(snapshotPath, initial);
    throw new Error(
      `WatchPR did not start because ${ref.url} is already ${initial.state.toLowerCase()}.`,
    );
  }

  assertBackgroundProcessCapacity();
  installMonitorProcessExitCleanup();
  const taskId = getNextMonitorId();
  const outputFile = createBackgroundOutputFile(taskId);
  const output =
    deps.createOutputWriter?.(outputFile) ??
    new MonitorOutputWriter(outputFile);
  if (
    !output.append(
      `[initial snapshot]\n${describeGitHubPullRequestSnapshot(initial)}${changesSincePreviousWatch}\n`,
    )
  ) {
    rmSync(outputFile, { force: true });
    throw new Error(`WatchPR could not write its output file: ${outputFile}`);
  }
  saveSnapshot(snapshotPath, initial);
  const actingUserId = getRuntimeActingUserAttribution();
  const description = `PR ${ref.owner}/${ref.repo}#${ref.number} checks, reviews, and mergeability`;
  const controller = new AbortController();
  const secrets: Readonly<Record<string, string>> = {};
  let processState: BackgroundProcess;
  const persistent = !isManagedCloudRuntime();
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
  void (async () => {
    let previous = initial;
    let failedPolls = 0;
    let lastError = "";
    while (processState.status === "running") {
      try {
        await wait(controller.signal, pollDelayMs(failedPolls));
        if (processState.status !== "running") return;
        const current = await fetchSnapshot(ref, {
          cwd,
          signal: controller.signal,
        });
        if (processState.status !== "running") return;
        if (failedPolls > 0) {
          emit([
            `WatchPR recovered after ${failedPolls} failed poll${failedPolls === 1 ? "" : "s"}.`,
          ]);
          failedPolls = 0;
          lastError = "";
        }
        const sameHead = current.headSha === previous.headSha;
        const stableCurrent = { ...current, readinessConfirmed: false };
        stableCurrent.readinessConfirmed = Boolean(
          sameHead &&
            hasGitHubPullRequestReadyConditions(previous) &&
            hasGitHubPullRequestReadyConditions(stableCurrent),
        );
        saveSnapshot(snapshotPath, stableCurrent);
        const diff = diffGitHubPullRequestSnapshots(previous, stableCurrent);
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
        if (controller.signal.aborted || processState.status !== "running") {
          return;
        }
        failedPolls += 1;
        const message = errorText(error);
        if (!output.append(`[poll error ${failedPolls}] ${message}\n`)) {
          processState.completionNotificationSuppressed = true;
          markMonitorFinished(taskId, processState, "failed", null);
          controller.abort();
          return;
        }
        if (failedPolls === 1 || message !== lastError) {
          emit([`WatchPR could not refresh ${ref.url}: ${message}. Retrying.`]);
        }
        lastError = message;
      }
    }
  })()
    .catch((error: unknown) => {
      if (processState.status !== "running") return;
      emit([`WatchPR stopped after an unexpected error: ${errorText(error)}`]);
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
        text: `WatchPR started (task ${taskId}). It will keep watching after CI finishes and report new failures, reviews, comments, conflicts, head changes, merge-state changes, and watcher errors. It stops when the PR merges/closes, on TaskStop, or when this session ends.${persistent ? "" : ` A hard ${maxTimeoutMs / 3_600_000}-hour limit applies in this Cloud sandbox; call WatchPR again to re-arm it, or use Wake or cron for much longer waits.`}\n\nCurrent state:\n${describeGitHubPullRequestSnapshot(initial)}${changesSincePreviousWatch}\n\nOutput file: ${outputFile}`,
      },
    ],
    taskId,
    url: ref.url,
    headSha: initial.headSha,
    persistent,
  };
}
