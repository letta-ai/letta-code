import { setTimeout as delay } from "node:timers/promises";
import { APIError } from "@letta-ai/letta-client";
import { getClient } from "@/backend/api/client";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { resolveBackendMode } from "@/backend/backend-mode";
import { telemetry } from "@/telemetry";
import type {
  GitHubPullRequestRef,
  GitHubPullRequestSnapshot,
  PullRequestCheck,
  PullRequestComment,
  PullRequestState,
} from "./github-pull-request-types";
import { fetchGitHubPullRequestSnapshot } from "./github-pull-request-watch";

type SnapshotOptions = { cwd: string; signal?: AbortSignal };
type FetchSnapshot = (
  ref: GitHubPullRequestRef,
  options: SnapshotOptions,
) => Promise<GitHubPullRequestSnapshot>;

// TODO: switch to the generated @letta-ai/letta-client types once the SDK
// includes POST /v1/integrations/github/pull-request-snapshots.
interface CloudComment {
  id: string;
  author: string;
  body: string;
  url: string;
  updated_at: string;
}

interface CloudPullRequestSnapshot {
  ref: GitHubPullRequestRef;
  head_sha: string;
  state: PullRequestState;
  is_draft: boolean;
  merged: boolean;
  merged_by: string | null;
  mergeable: string;
  merge_state_status: string;
  review_decision: string;
  readiness_confirmed: boolean;
  checks: PullRequestCheck[];
  check_attempts: PullRequestCheck[];
  comments: CloudComment[];
  reviews: Array<CloudComment & { state: string; commit_sha?: string }>;
  review_threads: Array<{
    id: string;
    is_resolved: boolean;
    comments: Array<
      CloudComment & {
        path?: string;
        line?: number;
        outdated: boolean;
        commit_sha?: string;
      }
    >;
  }>;
}

interface CloudPullRequestKey {
  owner: string;
  repo: string;
  number: number;
}

export interface CloudSnapshotResponse {
  snapshots: Array<
    CloudPullRequestKey & {
      snapshot: CloudPullRequestSnapshot | null;
      inaccessible: boolean;
      stale: boolean;
      retry_at?: string;
    }
  >;
  rate_limits?: Array<CloudPullRequestKey & { retry_at: string }>;
}

type CloudSnapshotResult =
  | { status: 200; body: CloudSnapshotResponse }
  | { status: 404 | 429 | 501 };

interface CloudSnapshotDeps {
  isCloud?: () => boolean;
  fetchGh?: FetchSnapshot;
  request?: (
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ) => Promise<CloudSnapshotResult>;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

// Used when the server signals a cooldown without a usable retry time.
const DEFAULT_COOLDOWN_MS = 30_000;

async function requestSnapshot(
  ref: GitHubPullRequestRef,
  signal?: AbortSignal,
): Promise<CloudSnapshotResult> {
  const client = await getClient();
  try {
    const body = await client.post<CloudSnapshotResponse>(
      "/v1/integrations/github/pull-request-snapshots",
      {
        body: {
          pull_requests: [
            { owner: ref.owner, repo: ref.repo, number: ref.number },
          ],
        },
        signal,
        // Handle quota cooldown here instead of the SDK's automatic retries.
        maxRetries: 0,
        timeout: 30_000,
      },
    );
    return { status: 200, body };
  } catch (error) {
    if (
      error instanceof APIError &&
      (error.status === 404 || error.status === 501 || error.status === 429)
    ) {
      return { status: error.status };
    }
    throw error;
  }
}

function sameRef(a: CloudPullRequestKey, b: CloudPullRequestKey): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.number === b.number
  );
}

function toComment(comment: CloudComment): PullRequestComment {
  return {
    id: comment.id,
    author: comment.author,
    body: comment.body,
    url: comment.url,
    updatedAt: comment.updated_at,
  };
}

function toClientSnapshot(
  ref: GitHubPullRequestRef,
  snapshot: CloudPullRequestSnapshot,
): GitHubPullRequestSnapshot {
  return {
    ref: { ...ref, url: snapshot.ref.url },
    headSha: snapshot.head_sha,
    state: snapshot.merged ? "MERGED" : snapshot.state,
    isDraft: snapshot.is_draft,
    mergeable: snapshot.mergeable,
    mergeStateStatus: snapshot.merge_state_status,
    reviewDecision: snapshot.review_decision,
    // Readiness still requires two same-head client reads.
    readinessConfirmed: false,
    checks: snapshot.checks,
    checkAttempts: snapshot.check_attempts,
    comments: snapshot.comments.map(toComment),
    reviews: snapshot.reviews.map((review) => ({
      ...toComment(review),
      state: review.state,
      commitSha: review.commit_sha,
    })),
    reviewThreads: snapshot.review_threads.map((thread) => ({
      id: thread.id,
      isResolved: thread.is_resolved,
      comments: thread.comments.map((comment) => ({
        ...toComment(comment),
        path: comment.path,
        line: comment.line,
        outdated: comment.outdated,
        commitSha: comment.commit_sha,
      })),
    })),
  };
}

/** One fetcher per watch: capability and telemetry state never leak to other watches. */
export function createGitHubPullRequestSnapshotFetcher(
  deps: CloudSnapshotDeps = {},
): FetchSnapshot {
  const shouldFetchCloud =
    deps.isCloud ??
    (() => resolveBackendMode() === "api" && isCloudServerUrl());
  const fetchGh = deps.fetchGh ?? fetchGitHubPullRequestSnapshot;
  const request = deps.request ?? requestSnapshot;
  const now = deps.now ?? Date.now;
  const wait =
    deps.wait ??
    (async (ms, signal) => {
      await delay(ms, undefined, { signal });
    });
  let unsupported = false;
  let reportedRateLimit = false;

  const pause = async (retryAt: string | undefined, signal?: AbortSignal) => {
    if (!reportedRateLimit) {
      reportedRateLimit = true;
      telemetry.trackError(
        "github_rate_limit",
        "Cloud PR snapshot polling paused for GitHub quota cooldown",
        "watch_pr",
      );
    }
    const remaining = Date.parse(retryAt ?? "") - now();
    // A missing or expired retry time must not cause a busy retry loop.
    await wait(remaining > 0 ? remaining : DEFAULT_COOLDOWN_MS, signal);
  };

  return async (ref, options) => {
    if (unsupported || !shouldFetchCloud()) return fetchGh(ref, options);
    while (true) {
      options.signal?.throwIfAborted();
      const result = await request(ref, options.signal);
      if (!("body" in result)) {
        // The endpoint reports quota as 200 + rate_limits; 429 is defensive.
        if (result.status === 429) {
          await pause(undefined, options.signal);
          continue;
        }
        // 404/501: an older Cloud without the route.
        unsupported = true;
        return fetchGh(ref, options);
      }
      const entry = result.body.snapshots.find((item) => sameRef(item, ref));
      const limit = result.body.rate_limits?.find((item) => sameRef(item, ref));
      // Stale data must never advance the baseline, so wait for fresh data.
      if (limit || entry?.stale) {
        await pause(entry?.retry_at ?? limit?.retry_at, options.signal);
        continue;
      }
      if (entry?.inaccessible) {
        throw new Error(`Cloud could not access ${ref.url}`);
      }
      if (!entry?.snapshot) {
        throw new Error("Cloud returned no PR snapshot");
      }
      return toClientSnapshot(ref, entry.snapshot);
    }
  };
}
