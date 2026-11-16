import { actingUserRequestOptions } from "@/agent/acting-user";
import { ApiRequestError, apiRequest } from "@/backend/api/request";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { resolveBackendMode } from "@/backend/backend-mode";
import { experimentManager } from "@/experiments/manager";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";
import { resolveNotificationScope } from "@/utils/task-notifications";
import type { PullRequestEventKind } from "./github-pull-request-diff";
import { parseGitHubPullRequestUrl } from "./github-pull-request-watch";
import { getMonitorMaxTimeoutMs } from "./monitor-timeout";
import { isCloudMonitorId } from "./monitor-url-cloud";

interface Args {
  resume?: string;
  url?: string;
  notify_on?: PullRequestEventKind[];
  parentScope?: { agentId: string; conversationId: string };
}
interface Deps {
  enabled?: () => boolean;
  request?: typeof apiRequest;
}

/** Register a durable watch without starting a sandbox process or timer. */
export async function startCloudPullRequestWatch(args: Args, deps: Deps = {}) {
  const resuming = Boolean(args.resume && isCloudMonitorId(args.resume));
  const enabled =
    deps.enabled ??
    (() =>
      experimentManager.isEnabled("cloud_watch_pr") &&
      isManagedCloudRuntime() &&
      resolveBackendMode() === "api" &&
      isCloudServerUrl());
  if (!resuming && !enabled()) return undefined;
  // Workflow-run watches keep their existing implementation.
  if (!resuming && args.url?.includes("/actions/runs/")) return undefined;
  const scope = resolveNotificationScope(args.parentScope);
  if (!scope || scope.conversationId === "default") return undefined;
  const path = `/v1/conversations/${encodeURIComponent(scope.conversationId)}/cloud-monitors`;
  const request = deps.request ?? apiRequest;
  if (resuming) {
    const record = await request<{
      id: string;
      status: string;
      source: { type: string; owner: string; repo: string; number: number };
    }>(
      "GET",
      `${path}/${encodeURIComponent(args.resume ?? "")}`,
      undefined,
      actingUserRequestOptions(scope.actingUserId),
    );
    if (record.source.type !== "github_pull_request")
      throw new Error("Use Monitor for this cloud monitor.");
    const { owner, repo, number } = record.source;
    return {
      content: [
        {
          type: "text" as const,
          text: `WatchPR ${record.id} is ${record.status}. Cloud watches continue between sessions; start a new watch after it stops.`,
        },
      ],
      taskId: record.id,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
      headSha: "",
      persistent: false,
    };
  }
  if (typeof args.url !== "string") throw new Error("WatchPR url is required");
  const ref = parseGitHubPullRequestUrl(args.url);
  let created: { id: string };
  try {
    created = await request<{ id: string }>(
      "POST",
      path,
      {
        description: `PR ${ref.owner}/${ref.repo}#${ref.number} checks, reviews, and mergeability`,
        source: {
          type: "github_pull_request",
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          ...(args.notify_on && { notify_on: args.notify_on }),
        },
        timeout_ms: getMonitorMaxTimeoutMs(),
      },
      actingUserRequestOptions(scope.actingUserId),
    );
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 400) {
      let body: { errorCode?: string } = {};
      try {
        body = JSON.parse(error.responseText);
      } catch {
        /* Preserve malformed errors. */
      }
      if (
        body.errorCode === "REPOSITORY_INACCESSIBLE" ||
        body.errorCode === "CLOUD_WATCH_PR_DISABLED"
      )
        return undefined;
    }
    throw error;
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `WatchPR started (task ${created.id}). You will be notified on PR events. It stops when the PR merges/closes, on TaskStop, or at its timeout. Keep working — do not poll or sleep.`,
      },
    ],
    taskId: created.id,
    url: ref.url,
    headSha: "",
    persistent: false,
  };
}
