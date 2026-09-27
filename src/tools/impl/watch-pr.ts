import { setTimeout as delay } from "node:timers/promises";
import {
  getCurrentWorkingDirectory,
  getRuntimeActingUserId,
  getRuntimeContext,
} from "@/runtime-context";
import { scrubSecretsFromString } from "@/tools/secret-substitution";
import { addToMessageQueue } from "@/utils/message-queue-bridge";
import {
  formatMonitorEventNotification,
  resolveNotificationScope,
} from "@/utils/task-notifications";
import { diffGitHubPullRequestSnapshots } from "./github-pull-request-diff";
import {
  describeGitHubPullRequestSnapshot,
  fetchGitHubPullRequestSnapshot,
  type GitHubPullRequestRef,
  type GitHubPullRequestSnapshot,
  hasGitHubPullRequestReadyConditions,
  parseGitHubPullRequestUrl,
} from "./github-pull-request-watch";
import { installMonitorProcessExitCleanup } from "./monitor";
import { createMonitorEventStream } from "./monitor-event-stream";
import {
  appendToOutputFile,
  assertBackgroundProcessCapacity,
  type BackgroundProcess,
  backgroundProcesses,
  createBackgroundOutputFile,
  getNextMonitorId,
  notifyBackgroundProcessStateChanged,
  scheduleBackgroundProcessCleanup,
  scrubCompletedBackgroundOutput,
} from "./process_manager";

const WATCH_POLL_MS = 30_000;

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
  persistent: true;
}

interface WatchPullRequestDeps {
  fetchSnapshot?: (
    ref: GitHubPullRequestRef,
    options: { cwd: string; signal?: AbortSignal },
  ) => Promise<GitHubPullRequestSnapshot>;
  wait?: (signal: AbortSignal) => Promise<void>;
}

function markWatchFinished(
  taskId: string,
  processState: BackgroundProcess,
  status: "completed" | "failed",
): void {
  processState.status = status;
  processState.exitCode = status === "completed" ? 0 : null;
  scrubCompletedBackgroundOutput(processState);
  notifyBackgroundProcessStateChanged(processState.runtimeScope);
  scheduleBackgroundProcessCleanup(taskId);
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return scrubSecretsFromString(message, {})
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function defaultWait(signal: AbortSignal): Promise<void> {
  await delay(WATCH_POLL_MS, undefined, { signal });
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
  const initial = await fetchSnapshot(ref, { cwd, signal: args.signal });
  args.signal?.throwIfAborted();
  if (initial.state !== "OPEN") {
    throw new Error(
      `WatchPR did not start because ${ref.url} is already ${initial.state.toLowerCase()}.`,
    );
  }

  assertBackgroundProcessCapacity();
  installMonitorProcessExitCleanup();
  const taskId = getNextMonitorId();
  const outputFile = createBackgroundOutputFile(taskId);
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
  const actingUserId = getRuntimeActingUserId();
  const description = `PR ${ref.owner}/${ref.repo}#${ref.number} checks, reviews, and mergeability`;
  const controller = new AbortController();
  let processState: BackgroundProcess;

  const events = createMonitorEventStream({
    emit(event) {
      const sanitized = scrubSecretsFromString(event, {});
      addToMessageQueue({
        kind: "task_notification",
        text: formatMonitorEventNotification({
          taskId,
          description,
          event: sanitized,
        }),
        ...scope,
        ...(actingUserId ? { actingUserId } : {}),
      });
    },
    stopSource() {
      if (!processState || processState.status !== "running") return;
      processState.completionNotificationSuppressed = true;
      appendToOutputFile(outputFile, "\n[stopped: output rate too high]\n");
      markWatchFinished(taskId, processState, "failed");
      controller.abort();
    },
  });

  const emit = (lines: readonly string[]): void => {
    if (lines.length === 0 || processState.status !== "running") return;
    const text = scrubSecretsFromString(`${lines.join("\n")}\n`, {});
    if (!appendToOutputFile(outputFile, text)) {
      processState.completionNotificationSuppressed = true;
      markWatchFinished(taskId, processState, "failed");
      controller.abort();
      return;
    }
    events.onData(text);
  };

  processState = {
    process: {
      kill() {
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
    persistent: true,
    secrets: {},
  };
  backgroundProcesses.set(taskId, processState);
  notifyBackgroundProcessStateChanged(scope);
  appendToOutputFile(
    outputFile,
    `[initial snapshot]\n${describeGitHubPullRequestSnapshot(initial)}\n`,
  );

  const wait = deps.wait ?? defaultWait;
  void (async () => {
    let previous = initial;
    let failedPolls = 0;
    let lastError = "";
    while (processState.status === "running") {
      try {
        await wait(controller.signal);
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
        const diff = diffGitHubPullRequestSnapshots(previous, stableCurrent);
        emit(diff.events);
        previous = stableCurrent;
        if (diff.terminal) {
          events.finish();
          if (processState.status === "running") {
            markWatchFinished(taskId, processState, "completed");
          }
          return;
        }
      } catch (error) {
        if (controller.signal.aborted || processState.status !== "running") {
          return;
        }
        failedPolls += 1;
        const message = errorText(error);
        appendToOutputFile(
          outputFile,
          `[poll error ${failedPolls}] ${message}\n`,
        );
        if (failedPolls === 1 || message !== lastError) {
          emit([`WatchPR could not refresh ${ref.url}: ${message}. Retrying.`]);
        }
        lastError = message;
      }
    }
  })().catch((error: unknown) => {
    if (processState.status !== "running") return;
    emit([`WatchPR stopped after an unexpected error: ${errorText(error)}`]);
    events.finish();
    if (processState.status === "running") {
      markWatchFinished(taskId, processState, "failed");
    }
  });

  return {
    content: [
      {
        type: "text",
        text: `WatchPR started (task ${taskId}). It will keep watching after CI finishes and report new failures, reviews, comments, conflicts, head changes, merge-state changes, and watcher errors. It stops when the PR merges/closes, on TaskStop, or when this session ends.\n\nCurrent state:\n${describeGitHubPullRequestSnapshot(initial)}\n\nOutput file: ${outputFile}`,
      },
    ],
    taskId,
    url: ref.url,
    headSha: initial.headSha,
    persistent: true,
  };
}
