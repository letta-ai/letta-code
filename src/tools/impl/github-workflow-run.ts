import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { APIConnectionError, APIError } from "@letta-ai/letta-client";
import { getClient } from "@/backend/api/client";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { resolveBackendMode } from "@/backend/backend-mode";
import { GitHubPullRequestSnapshotPending } from "./github-pull-request-cloud";
import type {
  GitHubPullRequestRef,
  GitHubPullRequestSnapshot,
  WorkflowRun,
} from "./github-pull-request-types";

export function parseGitHubWorkflowRunUrl(value: string): GitHubPullRequestRef {
  const url = new URL(value);
  const match = url.pathname.match(
    /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9]\d*)\/?$/,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    !match
  ) {
    throw new Error(
      "WatchPR url must look like https://github.com/owner/repo/actions/runs/123",
    );
  }
  const [, owner, repo, id] = match;
  if (!owner || !repo || !id || !Number.isSafeInteger(Number(id)))
    throw new Error("Invalid workflow run URL");
  return {
    owner,
    repo,
    number: Number(id),
    url: `https://github.com/${owner}/${repo}/actions/runs/${id}`,
  };
}

export function workflowRunSnapshot(
  ref: GitHubPullRequestRef,
  run: WorkflowRun,
): GitHubPullRequestSnapshot {
  if (!run.status || !run.headSha || !Array.isArray(run.jobs))
    throw new Error("Invalid workflow run snapshot");
  return {
    ref,
    headSha: run.headSha,
    state: run.status === "completed" ? "CLOSED" : "OPEN",
    isDraft: false,
    mergeable: "UNKNOWN",
    mergeStateStatus: "UNKNOWN",
    reviewDecision: "NONE",
    readinessConfirmed: false,
    checks: [],
    checkAttempts: [],
    comments: [],
    reviews: [],
    reviewThreads: [],
    workflowRun: run,
  };
}

export function describeWorkflowRun(
  snapshot: GitHubPullRequestSnapshot,
): string {
  const run = snapshot.workflowRun;
  if (!run) throw new Error("Missing workflow run");
  const failures = run.jobs
    .filter((job) => job.conclusion === "failure")
    .map((job) => {
      const steps = (job.steps ?? [])
        .filter((step) => step.conclusion === "failure")
        .map((step) => step.name);
      return `${job.name}${steps.length ? ` (${steps.join(", ")})` : ""}`;
    });
  return `Workflow run ${snapshot.ref.url}: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""}.${failures.length ? ` Failed jobs/steps: ${failures.join("; ")}.` : ""}`;
}

interface RunFetcherDeps {
  isCloud?: () => boolean;
  request?: (
    ref: GitHubPullRequestRef,
    signal?: AbortSignal,
  ) => Promise<
    | {
        snapshot: WorkflowRun | null;
        inaccessible: boolean;
        stale: boolean;
        retry_at?: string;
      }
    | undefined
  >;
  runGh?: (
    args: string[],
    options: { cwd: string; signal?: AbortSignal },
  ) => Promise<string>;
}

async function requestRun(ref: GitHubPullRequestRef, signal?: AbortSignal) {
  const client = await getClient();
  try {
    const response = await client.post<{
      workflow_runs?: Array<{
        owner: string;
        repo: string;
        number: number;
        snapshot: WorkflowRun | null;
        inaccessible: boolean;
        stale: boolean;
        retry_at?: string;
      }>;
    }>("/v1/integrations/github/pull-request-snapshots", {
      body: {
        pull_requests: [],
        workflow_runs: [
          { owner: ref.owner, repo: ref.repo, number: ref.number },
        ],
      },
      signal,
      maxRetries: 0,
      timeout: 30_000,
    });
    return response.workflow_runs?.find(
      (item) =>
        item.owner.toLowerCase() === ref.owner.toLowerCase() &&
        item.repo.toLowerCase() === ref.repo.toLowerCase() &&
        item.number === ref.number,
    );
  } catch (error) {
    // Old servers require at least one PR and do not understand workflow_runs.
    if (
      error instanceof APIError &&
      [400, 404, 422, 501].includes(error.status ?? 0)
    )
      return undefined;
    throw error;
  }
}

export function createGitHubWorkflowRunFetcher(deps: RunFetcherDeps = {}) {
  let unsupported = false;
  const runGh =
    deps.runGh ??
    (async (args, options) =>
      (
        await promisify(execFile)("gh", args, {
          ...options,
          timeout: 30_000,
          maxBuffer: 5 * 1024 * 1024,
          encoding: "utf8",
          windowsHide: true,
        })
      ).stdout);
  return async (
    ref: GitHubPullRequestRef,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<GitHubPullRequestSnapshot> => {
    if (
      !unsupported &&
      (
        deps.isCloud ??
        (() => resolveBackendMode() === "api" && isCloudServerUrl())
      )()
    ) {
      try {
        const entry = await (deps.request ?? requestRun)(ref, options.signal);
        if (entry) {
          if (entry.inaccessible)
            throw new Error(`Cloud could not access ${ref.url}`);
          if (entry.stale || entry.retry_at)
            throw new GitHubPullRequestSnapshotPending();
          if (!entry.snapshot)
            throw new Error("Cloud returned no workflow run snapshot");
          return workflowRunSnapshot(ref, entry.snapshot);
        }
        unsupported = true;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (!(error instanceof APIConnectionError)) throw error;
      }
    }
    const run = JSON.parse(
      await runGh(
        [
          "run",
          "view",
          String(ref.number),
          "-R",
          `${ref.owner}/${ref.repo}`,
          "--json",
          "status,conclusion,headSha,jobs",
        ],
        options,
      ),
    ) as WorkflowRun;
    return workflowRunSnapshot(ref, run);
  };
}
