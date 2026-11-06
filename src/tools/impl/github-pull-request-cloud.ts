import { setTimeout as delay } from "node:timers/promises";
import { APIError } from "@letta-ai/letta-client";
import { getClient } from "@/backend/api/client";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { isLocalBackendEnvEnabled } from "@/backend/local/paths";
import { telemetry } from "@/telemetry";
import type {
  GitHubPullRequestRef,
  GitHubPullRequestSnapshot,
} from "./github-pull-request-types";
import { fetchGitHubPullRequestSnapshot } from "./github-pull-request-watch";

type SnapshotOptions = { cwd: string; signal?: AbortSignal };
type FetchSnapshot = (
  ref: GitHubPullRequestRef,
  options: SnapshotOptions,
) => Promise<GitHubPullRequestSnapshot>;

interface SnapshotResponse {
  snapshots: Array<{
    owner: string;
    repo: string;
    number: number;
    snapshot:
      | (GitHubPullRequestSnapshot & {
          merged: boolean;
          mergedBy: string | null;
        })
      | null;
    inaccessible: boolean;
    stale: boolean;
    retry_at?: string;
  }>;
  retry_at?: string;
}

interface CloudSnapshotDeps {
  isCloud?: () => boolean;
  fetchGh?: FetchSnapshot;
  request?: (
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ) => Promise<{ status: number; body: unknown }>;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  reportRateLimit?: () => void;
}

async function requestSnapshot(
  ref: GitHubPullRequestRef,
  signal?: AbortSignal,
) {
  const client = await getClient();
  try {
    const body = await client.post<SnapshotResponse>(
      "/v1/integrations/github/pull-request-snapshots",
      {
        body: {
          prs: [{ owner: ref.owner, repo: ref.repo, number: ref.number }],
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
      return { status: error.status, body: error.error };
    }
    throw error;
  }
}

/** One fetcher per watch: capability and telemetry state never leak to other watches. */
export function createGitHubPullRequestSnapshotFetcher(
  deps: CloudSnapshotDeps = {},
): FetchSnapshot {
  const shouldFetchCloud =
    deps.isCloud ?? (() => !isLocalBackendEnvEnabled() && isCloudServerUrl());
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

  return async (ref, options) => {
    if (unsupported || !shouldFetchCloud()) return fetchGh(ref, options);
    while (true) {
      options.signal?.throwIfAborted();
      const { status, body } = await request(ref, options.signal);
      if (status === 404 || status === 501) {
        unsupported = true;
        return fetchGh(ref, options);
      }
      if (status !== 200 && status !== 429) {
        throw new Error(`Cloud PR snapshot request failed (${status})`);
      }
      const response = body as SnapshotResponse | undefined;
      const entry = response?.snapshots?.find(
        (item) =>
          item.owner.toLowerCase() === ref.owner.toLowerCase() &&
          item.repo.toLowerCase() === ref.repo.toLowerCase() &&
          item.number === ref.number,
      );
      if (status === 429 || entry?.stale) {
        if (!reportedRateLimit) {
          reportedRateLimit = true;
          if (deps.reportRateLimit) deps.reportRateLimit();
          else
            telemetry.trackError(
              "github_rate_limit",
              "Cloud PR snapshot polling paused for GitHub quota cooldown",
              "watch_pr",
            );
        }
        const retryAt = Date.parse(entry?.retry_at ?? response?.retry_at ?? "");
        // A missing/expired retry timestamp must not cause a busy retry loop.
        const remaining = Number.isFinite(retryAt) ? retryAt - now() : 0;
        await wait(remaining > 0 ? remaining : 30_000, options.signal);
        continue;
      }
      if (entry?.inaccessible) {
        throw new Error(`Cloud could not access ${ref.url}`);
      }
      const snapshot = entry?.snapshot;
      if (
        !snapshot?.headSha ||
        !Array.isArray(snapshot.checks) ||
        !Array.isArray(snapshot.checkAttempts) ||
        !Array.isArray(snapshot.comments) ||
        !Array.isArray(snapshot.reviews) ||
        !Array.isArray(snapshot.reviewThreads)
      ) {
        throw new Error("Cloud returned an invalid PR snapshot");
      }
      // The wire snapshot uses the existing diff shape. Readiness still requires
      // two successful client reads; stale data must never advance the baseline.
      return {
        ref: { ...ref, url: snapshot.ref.url },
        headSha: snapshot.headSha,
        state: snapshot.merged ? "MERGED" : snapshot.state,
        isDraft: snapshot.isDraft,
        mergeable: snapshot.mergeable,
        mergeStateStatus: snapshot.mergeStateStatus,
        reviewDecision: snapshot.reviewDecision,
        readinessConfirmed: false,
        checks: snapshot.checks,
        checkAttempts: snapshot.checkAttempts,
        comments: snapshot.comments,
        reviews: snapshot.reviews,
        reviewThreads: snapshot.reviewThreads,
      };
    }
  };
}
