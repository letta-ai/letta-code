import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  GITHUB_PULL_REQUEST_METADATA_QUERY,
  GITHUB_PULL_REQUEST_QUERY,
  GITHUB_REVIEW_THREAD_QUERY,
} from "./github-pull-request-query";

const execFileAsync = promisify(execFile);

export interface GitHubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";
export type PullRequestCheckPhase =
  | "pending"
  | "success"
  | "neutral"
  | "failure";

export interface PullRequestCheck {
  key: string;
  name: string;
  phase: PullRequestCheckPhase;
  result: string;
  url?: string;
}

export interface PullRequestComment {
  id: string;
  author: string;
  body: string;
  url: string;
  updatedAt: string;
}

export interface PullRequestReview extends PullRequestComment {
  state: string;
  commitSha?: string;
}

export interface PullRequestInlineComment extends PullRequestComment {
  path?: string;
  line?: number;
  outdated: boolean;
  commitSha?: string;
}

export interface PullRequestReviewThread {
  id: string;
  isResolved: boolean;
  comments: PullRequestInlineComment[];
}

export interface GitHubPullRequestSnapshot {
  ref: GitHubPullRequestRef;
  headSha: string;
  state: PullRequestState;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  snapshotComplete: boolean;
  readinessConfirmed: boolean;
  checks: PullRequestCheck[];
  checkAttempts: PullRequestCheck[];
  comments: PullRequestComment[];
  reviews: PullRequestReview[];
  reviewThreads: PullRequestReviewThread[];
}

interface GitHubPullRequestWatchDeps {
  runGh?: (
    args: string[],
    options: { cwd: string; signal?: AbortSignal },
  ) => Promise<string>;
}

interface GraphQlAuthor {
  login?: string | null;
}

interface GraphQlComment {
  id?: string | null;
  author?: GraphQlAuthor | null;
  body?: string | null;
  url?: string | null;
  updatedAt?: string | null;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  outdated?: boolean | null;
  commit?: { oid?: string | null } | null;
}

interface GraphQlReview extends GraphQlComment {
  state?: string | null;
}

interface GraphQlReviewThread {
  id?: string | null;
  isResolved?: boolean | null;
  comments?: {
    nodes?: Array<GraphQlComment | null> | null;
    pageInfo?: {
      hasPreviousPage?: boolean | null;
      startCursor?: string | null;
    } | null;
  } | null;
}

interface GraphQlCheck {
  __typename?: string | null;
  databaseId?: number | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  id?: string | null;
  context?: string | null;
  state?: string | null;
  targetUrl?: string | null;
}

interface GraphQlPullRequest {
  url?: string | null;
  state?: string | null;
  isDraft?: boolean | null;
  merged?: boolean | null;
  updatedAt?: string | null;
  headRefOid?: string | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  comments?: {
    nodes?: Array<GraphQlComment | null> | null;
    pageInfo?: GraphQlPageInfo | null;
  } | null;
  reviews?: {
    nodes?: Array<GraphQlReview | null> | null;
    pageInfo?: GraphQlPageInfo | null;
  } | null;
  reviewThreads?: {
    nodes?: Array<GraphQlReviewThread | null> | null;
    pageInfo?: GraphQlPageInfo | null;
    totalCount?: number | null;
  } | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          state?: string | null;
          contexts?: {
            nodes?: Array<GraphQlCheck | null> | null;
            pageInfo?: GraphQlPageInfo | null;
            totalCount?: number | null;
          } | null;
        } | null;
      } | null;
    } | null> | null;
  } | null;
}

interface GraphQlPageInfo {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
}

interface GraphQlPayload {
  data?: { repository?: { pullRequest?: GraphQlPullRequest | null } | null };
  errors?: Array<{ message?: string }>;
}

interface GraphQlReviewThreadPayload {
  data?: { node?: GraphQlReviewThread | null };
  errors?: Array<{ message?: string }>;
}

interface RestCheckRun {
  id?: number | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  details_url?: string | null;
  app?: { name?: string | null; slug?: string | null } | null;
  check_suite?: { id?: number | null } | null;
}

interface RestCheckSuite {
  id?: number | null;
  status?: string | null;
  conclusion?: string | null;
  url?: string | null;
  latest_check_runs_count?: number | null;
  app?: { name?: string | null; slug?: string | null } | null;
}

interface RestCommitStatus {
  id?: number | null;
  context?: string | null;
  state?: string | null;
  target_url?: string | null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function authorLogin(author?: GraphQlAuthor | null): string {
  return author?.login || "unknown";
}

function mapComment(comment: GraphQlComment): PullRequestComment | undefined {
  if (!comment.id || !comment.url) return undefined;
  return {
    id: comment.id,
    author: authorLogin(comment.author),
    body: comment.body ?? "",
    url: comment.url,
    updatedAt: comment.updatedAt ?? "",
  };
}

function mapReview(review: GraphQlReview): PullRequestReview | undefined {
  const comment = mapComment(review);
  if (!comment) return undefined;
  return {
    ...comment,
    state: review.state ?? "UNKNOWN",
    ...(review.commit?.oid ? { commitSha: review.commit.oid } : {}),
  };
}

function mapInlineComment(
  comment: GraphQlComment,
): PullRequestInlineComment | undefined {
  const mapped = mapComment(comment);
  if (!mapped) return undefined;
  return {
    ...mapped,
    ...(comment.path ? { path: comment.path } : {}),
    ...((comment.line ?? comment.originalLine)
      ? { line: comment.line ?? comment.originalLine ?? undefined }
      : {}),
    outdated: comment.outdated ?? false,
    ...(comment.commit?.oid ? { commitSha: comment.commit.oid } : {}),
  };
}

function mapGraphQlCheck(check: GraphQlCheck): PullRequestCheck | undefined {
  if (check.__typename === "CheckRun") {
    const name = check.name || "Unnamed check";
    const result =
      check.status === "COMPLETED"
        ? (check.conclusion ?? "UNKNOWN")
        : (check.status ?? "QUEUED");
    const phase: PullRequestCheckPhase =
      check.status !== "COMPLETED"
        ? "pending"
        : result === "SUCCESS"
          ? "success"
          : result === "NEUTRAL" || result === "SKIPPED"
            ? "neutral"
            : "failure";
    return {
      key: `check:${check.databaseId ?? check.detailsUrl ?? name}`,
      name,
      phase,
      result,
      ...(check.detailsUrl ? { url: check.detailsUrl } : {}),
    };
  }
  if (check.__typename === "StatusContext") {
    const name = check.context || "Unnamed status";
    const result = check.state ?? "PENDING";
    return {
      key: `status:${name}`,
      name,
      phase:
        result === "SUCCESS"
          ? "success"
          : result === "PENDING" || result === "EXPECTED"
            ? "pending"
            : "failure",
      result,
      ...(check.targetUrl ? { url: check.targetUrl } : {}),
    };
  }
  return undefined;
}

function checkRunPhase(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): PullRequestCheckPhase {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "success";
  if (conclusion === "neutral" || conclusion === "skipped") return "neutral";
  return "failure";
}

function mapRestCheckRun(run: RestCheckRun): PullRequestCheck | undefined {
  if (!run.id) return undefined;
  const status = run.status?.toLowerCase() ?? "queued";
  const conclusion = run.conclusion?.toLowerCase();
  const result = status === "completed" ? (conclusion ?? "unknown") : status;
  return {
    key: `attempt:${run.id}`,
    name: run.name || "Unnamed check",
    phase: checkRunPhase(status, conclusion),
    result: result.toUpperCase(),
    ...(run.details_url ? { url: run.details_url } : {}),
  };
}

function mapFailedCheckSuite(
  suite: RestCheckSuite,
): PullRequestCheck | undefined {
  if (
    !suite.id ||
    suite.status?.toLowerCase() !== "completed" ||
    !suite.conclusion ||
    ["success", "neutral", "skipped"].includes(
      suite.conclusion.toLowerCase(),
    ) ||
    (suite.latest_check_runs_count ?? 0) > 0
  ) {
    return undefined;
  }
  const app = suite.app?.name ?? suite.app?.slug ?? "Check suite";
  return {
    key: `suite:${suite.id}`,
    name: `${app} check suite`,
    phase: "failure",
    result: suite.conclusion.toUpperCase(),
    ...(suite.url ? { url: suite.url } : {}),
  };
}

function mapRestCommitStatus(
  status: RestCommitStatus,
): PullRequestCheck | undefined {
  if (!status.id) return undefined;
  const result = status.state?.toUpperCase() ?? "PENDING";
  return {
    key: `status-attempt:${status.id}`,
    name: status.context || "Unnamed status",
    phase:
      result === "SUCCESS"
        ? "success"
        : result === "PENDING" || result === "EXPECTED"
          ? "pending"
          : "failure",
    result,
    ...(status.target_url ? { url: status.target_url } : {}),
  };
}

function pullRequestState(pullRequest: GraphQlPullRequest): PullRequestState {
  if (pullRequest.merged || pullRequest.state === "MERGED") return "MERGED";
  return pullRequest.state === "CLOSED" ? "CLOSED" : "OPEN";
}

function mapSnapshot(
  ref: GitHubPullRequestRef,
  pullRequest: GraphQlPullRequest,
  checkAttempts: PullRequestCheck[],
): GitHubPullRequestSnapshot {
  if (!pullRequest.headRefOid) {
    throw new Error(`GitHub returned no head SHA for ${ref.url}`);
  }
  const reviewThreads = (pullRequest.reviewThreads?.nodes ?? []).flatMap(
    (thread): PullRequestReviewThread[] => {
      if (!thread?.id) return [];
      return [
        {
          id: thread.id,
          isResolved: thread.isResolved ?? false,
          comments: (thread.comments?.nodes ?? []).flatMap((comment) => {
            const mapped = comment ? mapInlineComment(comment) : undefined;
            return mapped ? [mapped] : [];
          }),
        },
      ];
    },
  );
  const rollup =
    pullRequest.commits?.nodes?.at(-1)?.commit?.statusCheckRollup ?? undefined;
  const checks = (rollup?.contexts?.nodes ?? []).flatMap((check) => {
    const mapped = check ? mapGraphQlCheck(check) : undefined;
    return mapped ? [mapped] : [];
  });
  const rollupState = rollup?.state ?? "";
  if (
    (rollupState === "ERROR" || rollupState === "FAILURE") &&
    !checks.some((check) => check.phase === "failure")
  ) {
    checks.push({
      key: "check-rollup",
      name: "GitHub check rollup",
      phase: "failure",
      result: rollupState,
    });
  } else if (
    (rollupState === "EXPECTED" || rollupState === "PENDING") &&
    !checks.some((check) => check.phase === "pending")
  ) {
    checks.push({
      key: "check-rollup",
      name: "GitHub check rollup",
      phase: "pending",
      result: rollupState,
    });
  }

  return {
    ref: {
      ...ref,
      url: pullRequest.url ?? ref.url,
    },
    headSha: pullRequest.headRefOid,
    state: pullRequestState(pullRequest),
    isDraft: pullRequest.isDraft ?? false,
    mergeable: pullRequest.mergeable ?? "UNKNOWN",
    mergeStateStatus: pullRequest.mergeStateStatus ?? "UNKNOWN",
    reviewDecision: pullRequest.reviewDecision ?? "NONE",
    snapshotComplete: !pullRequest.reviewThreads?.nodes?.some(
      (thread) => thread?.comments?.pageInfo?.hasPreviousPage,
    ),
    readinessConfirmed: false,
    checks,
    checkAttempts,
    comments: (pullRequest.comments?.nodes ?? []).flatMap((comment) => {
      const mapped = comment ? mapComment(comment) : undefined;
      return mapped ? [mapped] : [];
    }),
    reviews: (pullRequest.reviews?.nodes ?? []).flatMap((review) => {
      const mapped = review ? mapReview(review) : undefined;
      return mapped ? [mapped] : [];
    }),
    reviewThreads,
  };
}

async function defaultRunGh(
  args: string[],
  options: { cwd: string; signal?: AbortSignal },
): Promise<string> {
  const result = await execFileAsync("gh", args, {
    cwd: options.cwd,
    signal: options.signal,
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
  });
  return result.stdout;
}

function parseRestPages<T>(stdout: string, field: string): T[] {
  let pages: unknown;
  try {
    pages = JSON.parse(stdout);
  } catch {
    throw new Error(`GitHub returned invalid JSON while reading ${field}`);
  }
  if (!Array.isArray(pages)) {
    throw new Error(`GitHub returned an invalid ${field} response`);
  }
  const values: T[] = [];
  for (const page of pages) {
    if (typeof page !== "object" || page === null) continue;
    const entries = Reflect.get(page, field);
    if (Array.isArray(entries)) values.push(...(entries as T[]));
  }
  return values;
}

function parseRestArrays<T>(stdout: string, label: string): T[] {
  let pages: unknown;
  try {
    pages = JSON.parse(stdout);
  } catch {
    throw new Error(`GitHub returned invalid JSON while reading ${label}`);
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`GitHub returned an invalid ${label} response`);
  }
  return pages.flat() as T[];
}

export function parseGitHubPullRequestUrl(
  urlValue: string,
): GitHubPullRequestRef {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("WatchPR url must be a full GitHub pull request URL");
  }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    !match
  ) {
    throw new Error(
      "WatchPR url must look like https://github.com/owner/repo/pull/123",
    );
  }
  const [, owner, repo, numberValue] = match;
  if (!owner || !repo || !numberValue) {
    throw new Error(
      "WatchPR url is missing an owner, repository, or PR number",
    );
  }
  const number = Number.parseInt(numberValue, 10);
  return {
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

function parseGraphQlPage(
  stdout: string,
  ref: GitHubPullRequestRef,
): GraphQlPullRequest {
  let payload: GraphQlPayload;
  try {
    payload = JSON.parse(stdout) as GraphQlPayload;
  } catch {
    throw new Error("GitHub returned invalid JSON while reading the PR");
  }
  const errors = payload.errors?.map((item) => item.message).filter(Boolean);
  if (errors?.length) {
    throw new Error(`GitHub could not read ${ref.url}: ${errors.join("; ")}`);
  }
  const pullRequest = payload.data?.repository?.pullRequest;
  if (!pullRequest) {
    throw new Error(`GitHub could not find ${ref.url}`);
  }
  return pullRequest;
}

function appendCursorArg(
  args: string[],
  name: string,
  cursor: string | undefined,
): void {
  if (!cursor) return;
  args.push("-f", `${name}=${cursor}`);
}

function pullRequestMetadataKey(pullRequest: GraphQlPullRequest): string {
  const reviewThreads = pullRequest.reviewThreads?.nodes ?? [];
  const rollup =
    pullRequest.commits?.nodes?.at(-1)?.commit?.statusCheckRollup ?? undefined;
  const contexts = rollup?.contexts?.nodes ?? [];
  return JSON.stringify([
    pullRequest.state,
    pullRequest.isDraft,
    pullRequest.merged,
    pullRequest.headRefOid,
    pullRequest.mergeable,
    pullRequest.mergeStateStatus,
    pullRequest.reviewDecision,
    pullRequest.updatedAt,
    pullRequest.reviewThreads?.totalCount ?? reviewThreads.length,
    reviewThreads.slice(0, 100).map((thread) => {
      const comment = thread?.comments?.nodes?.at(-1);
      return [
        thread?.id,
        thread?.isResolved,
        comment?.id,
        comment?.updatedAt,
        comment?.outdated,
      ];
    }),
    rollup?.state,
    rollup?.contexts?.totalCount ?? contexts.length,
    contexts
      .slice(0, 100)
      .map((context) => [
        context?.__typename,
        context?.databaseId ?? context?.id,
        context?.name ?? context?.context,
        context?.status ?? context?.state,
        context?.conclusion,
        context?.detailsUrl ?? context?.targetUrl,
      ]),
  ]);
}

function uniqueNodes<T extends { id?: string | null }>(nodes: T[]): T[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (!node.id) return true;
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function parseReviewThreadPage(
  stdout: string,
  threadId: string,
): GraphQlReviewThread {
  let payload: GraphQlReviewThreadPayload;
  try {
    payload = JSON.parse(stdout) as GraphQlReviewThreadPayload;
  } catch {
    throw new Error(
      "GitHub returned invalid JSON while reading a review thread",
    );
  }
  const errors = payload.errors?.map((item) => item.message).filter(Boolean);
  if (errors?.length) {
    throw new Error(
      `GitHub could not read review thread: ${errors.join("; ")}`,
    );
  }
  if (!payload.data?.node || payload.data.node.id !== threadId) {
    throw new Error(`GitHub could not find review thread ${threadId}`);
  }
  return payload.data.node;
}

async function completeReviewThreadComments(
  thread: GraphQlReviewThread,
  runGh: NonNullable<GitHubPullRequestWatchDeps["runGh"]>,
  options: { cwd: string; signal?: AbortSignal },
): Promise<GraphQlReviewThread> {
  if (!thread.id || !thread.comments?.pageInfo?.hasPreviousPage) return thread;
  const comments = [...(thread.comments.nodes ?? [])];
  let before = thread.comments.pageInfo.startCursor ?? undefined;
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${GITHUB_REVIEW_THREAD_QUERY}`,
      "-f",
      `id=${thread.id}`,
    ];
    appendCursorArg(args, "before", before);
    const page = parseReviewThreadPage(await runGh(args, options), thread.id);
    comments.unshift(...(page.comments?.nodes ?? []));
    before = page.comments?.pageInfo?.startCursor ?? before;
    if (!page.comments?.pageInfo?.hasPreviousPage) break;
    if (pageCount === 99) {
      throw new Error(
        `GitHub review thread ${thread.id} exceeded 10,000 comments`,
      );
    }
  }
  return {
    ...thread,
    comments: {
      nodes: uniqueNodes(comments.filter(Boolean) as GraphQlComment[]),
      pageInfo: { hasPreviousPage: false },
    },
  };
}

export async function fetchGitHubPullRequestSnapshot(
  ref: GitHubPullRequestRef,
  options: {
    cwd: string;
    signal?: AbortSignal;
    deps?: GitHubPullRequestWatchDeps;
  },
): Promise<GitHubPullRequestSnapshot> {
  const runGh = options.deps?.runGh ?? defaultRunGh;
  let pullRequest: GraphQlPullRequest | undefined;
  const comments: Array<GraphQlComment | null> = [];
  const reviews: Array<GraphQlReview | null> = [];
  const reviewThreads: Array<GraphQlReviewThread | null> = [];
  const checkContexts: Array<GraphQlCheck | null> = [];
  let commentsAfter: string | undefined;
  let reviewsAfter: string | undefined;
  let threadsAfter: string | undefined;
  let contextsAfter: string | undefined;
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${GITHUB_PULL_REQUEST_QUERY}`,
      "-f",
      `owner=${ref.owner}`,
      "-f",
      `name=${ref.repo}`,
      "-F",
      `number=${ref.number}`,
    ];
    appendCursorArg(args, "commentsAfter", commentsAfter);
    appendCursorArg(args, "reviewsAfter", reviewsAfter);
    appendCursorArg(args, "threadsAfter", threadsAfter);
    appendCursorArg(args, "contextsAfter", contextsAfter);
    const page = parseGraphQlPage(
      await runGh(args, { cwd: options.cwd, signal: options.signal }),
      ref,
    );
    if (pullRequest?.headRefOid && page.headRefOid !== pullRequest.headRefOid) {
      throw new Error("GitHub PR head changed while WatchPR was reading it");
    }
    pullRequest ??= page;
    comments.push(...(page.comments?.nodes ?? []));
    reviews.push(...(page.reviews?.nodes ?? []));
    reviewThreads.push(...(page.reviewThreads?.nodes ?? []));
    const pageRollup =
      page.commits?.nodes?.at(-1)?.commit?.statusCheckRollup ?? undefined;
    checkContexts.push(...(pageRollup?.contexts?.nodes ?? []));
    commentsAfter = page.comments?.pageInfo?.endCursor ?? commentsAfter;
    reviewsAfter = page.reviews?.pageInfo?.endCursor ?? reviewsAfter;
    threadsAfter = page.reviewThreads?.pageInfo?.endCursor ?? threadsAfter;
    contextsAfter = pageRollup?.contexts?.pageInfo?.endCursor ?? contextsAfter;
    const hasNextPage = Boolean(
      page.comments?.pageInfo?.hasNextPage ||
        page.reviews?.pageInfo?.hasNextPage ||
        page.reviewThreads?.pageInfo?.hasNextPage ||
        pageRollup?.contexts?.pageInfo?.hasNextPage,
    );
    if (!hasNextPage) break;
    if (pageCount === 99) {
      throw new Error("GitHub PR discussion exceeded 10,000 items");
    }
  }
  if (!pullRequest) throw new Error(`GitHub could not find ${ref.url}`);
  const completedReviewThreads = await Promise.all(
    reviewThreads.filter(Boolean).map((thread) =>
      completeReviewThreadComments(thread as GraphQlReviewThread, runGh, {
        cwd: options.cwd,
        signal: options.signal,
      }),
    ),
  );
  pullRequest = {
    ...pullRequest,
    comments: {
      nodes: uniqueNodes(comments.filter(Boolean) as GraphQlComment[]),
      pageInfo: { hasNextPage: false },
    },
    reviews: {
      nodes: uniqueNodes(reviews.filter(Boolean) as GraphQlReview[]),
      pageInfo: { hasNextPage: false },
    },
    reviewThreads: {
      nodes: uniqueNodes(completedReviewThreads),
      pageInfo: { hasNextPage: false },
      totalCount: completedReviewThreads.length,
    },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state:
                pullRequest.commits?.nodes?.at(-1)?.commit?.statusCheckRollup
                  ?.state,
              contexts: {
                nodes: uniqueNodes(
                  checkContexts.filter(Boolean) as GraphQlCheck[],
                ),
                pageInfo: { hasNextPage: false },
                totalCount: checkContexts.length,
              },
            },
          },
        },
      ],
    },
  };
  if (!pullRequest.headRefOid) {
    throw new Error(`GitHub returned no head SHA for ${ref.url}`);
  }
  const commitPath = `repos/${ref.owner}/${ref.repo}/commits/${pullRequest.headRefOid}`;
  const [checkRunsJson, checkSuitesJson, statusesJson] = await Promise.all([
    runGh(
      [
        "api",
        "--paginate",
        "--slurp",
        `${commitPath}/check-runs?per_page=100&filter=all`,
      ],
      { cwd: options.cwd, signal: options.signal },
    ),
    runGh(
      [
        "api",
        "--paginate",
        "--slurp",
        `${commitPath}/check-suites?per_page=100`,
      ],
      { cwd: options.cwd, signal: options.signal },
    ),
    runGh(
      ["api", "--paginate", "--slurp", `${commitPath}/statuses?per_page=100`],
      { cwd: options.cwd, signal: options.signal },
    ),
  ]);
  const checkAttempts = parseRestPages<RestCheckRun>(
    checkRunsJson,
    "check_runs",
  );
  const mappedCheckAttempts = checkAttempts.flatMap((run) => {
    const mapped = mapRestCheckRun(run);
    return mapped ? [mapped] : [];
  });
  const commitStatuses = parseRestArrays<RestCommitStatus>(
    statusesJson,
    "commit statuses",
  );
  for (const status of commitStatuses) {
    const mapped = mapRestCommitStatus(status);
    if (mapped) mappedCheckAttempts.push(mapped);
  }
  const checkSuites = parseRestPages<RestCheckSuite>(
    checkSuitesJson,
    "check_suites",
  );
  for (const suite of checkSuites) {
    const mapped = mapFailedCheckSuite(suite);
    if (mapped) mappedCheckAttempts.push(mapped);
  }
  const snapshot = mapSnapshot(ref, pullRequest, mappedCheckAttempts);
  if (hasGitHubPullRequestReadyConditions(snapshot)) {
    const metadataArgs = [
      "api",
      "graphql",
      "-f",
      `query=${GITHUB_PULL_REQUEST_METADATA_QUERY}`,
      "-f",
      `owner=${ref.owner}`,
      "-f",
      `name=${ref.repo}`,
      "-F",
      `number=${ref.number}`,
    ];
    const latestMetadata = parseGraphQlPage(
      await runGh(metadataArgs, {
        cwd: options.cwd,
        signal: options.signal,
      }),
      ref,
    );
    if (
      pullRequestMetadataKey(latestMetadata) !==
      pullRequestMetadataKey(pullRequest)
    ) {
      throw new Error("GitHub PR state changed while WatchPR was reading it");
    }
  }
  return snapshot;
}

function failedChecks(snapshot: GitHubPullRequestSnapshot): PullRequestCheck[] {
  return snapshot.checks.filter((check) => check.phase === "failure");
}

function pendingChecks(
  snapshot: GitHubPullRequestSnapshot,
): PullRequestCheck[] {
  return snapshot.checks.filter((check) => check.phase === "pending");
}

function unresolvedThreads(
  snapshot: GitHubPullRequestSnapshot,
): PullRequestReviewThread[] {
  return snapshot.reviewThreads.filter((thread) => !thread.isResolved);
}

export function hasGitHubPullRequestReadyConditions(
  snapshot: GitHubPullRequestSnapshot,
): boolean {
  return (
    snapshot.state === "OPEN" &&
    !snapshot.isDraft &&
    snapshot.snapshotComplete &&
    snapshot.mergeable === "MERGEABLE" &&
    snapshot.mergeStateStatus === "CLEAN" &&
    (snapshot.reviewDecision === "NONE" ||
      snapshot.reviewDecision === "APPROVED") &&
    pendingChecks(snapshot).length === 0 &&
    failedChecks(snapshot).length === 0 &&
    unresolvedThreads(snapshot).length === 0
  );
}

export function isGitHubPullRequestReady(
  snapshot: GitHubPullRequestSnapshot,
): boolean {
  return (
    snapshot.readinessConfirmed && hasGitHubPullRequestReadyConditions(snapshot)
  );
}

function checkSummary(snapshot: GitHubPullRequestSnapshot): string {
  const pending = pendingChecks(snapshot).length;
  const failed = failedChecks(snapshot).length;
  const completed = snapshot.checks.length - pending;
  if (snapshot.checks.length === 0) return "no checks reported";
  return `${completed}/${snapshot.checks.length} checks complete, ${failed} failing, ${pending} pending`;
}

function blockerSummary(snapshot: GitHubPullRequestSnapshot): string {
  const blockers: string[] = [];
  if (snapshot.isDraft) blockers.push("draft");
  if (snapshot.mergeable === "CONFLICTING") blockers.push("merge conflicts");
  if (snapshot.mergeable === "UNKNOWN") {
    blockers.push("mergeability still unknown");
  }
  if (
    snapshot.mergeStateStatus !== "CLEAN" &&
    snapshot.mergeStateStatus !== "UNKNOWN"
  ) {
    blockers.push(`merge state ${snapshot.mergeStateStatus}`);
  }
  if (snapshot.mergeStateStatus === "UNKNOWN") {
    blockers.push("merge state still unknown");
  }
  if (
    snapshot.reviewDecision !== "NONE" &&
    snapshot.reviewDecision !== "APPROVED"
  ) {
    blockers.push(`review decision ${snapshot.reviewDecision}`);
  }
  if (!snapshot.snapshotComplete) {
    blockers.push("GitHub snapshot exceeded a 100-item page");
  }
  if (
    hasGitHubPullRequestReadyConditions(snapshot) &&
    !snapshot.readinessConfirmed
  ) {
    blockers.push("awaiting a second same-head readiness read");
  }
  const unresolved = unresolvedThreads(snapshot).length;
  if (unresolved > 0) {
    blockers.push(
      `${unresolved} unresolved review thread${unresolved === 1 ? "" : "s"}`,
    );
  }
  return blockers.length > 0 ? blockers.join(", ") : "no known blockers";
}

export function describeGitHubPullRequestSnapshot(
  snapshot: GitHubPullRequestSnapshot,
): string {
  const failing = failedChecks(snapshot);
  const lines = [
    `${snapshot.ref.owner}/${snapshot.ref.repo}#${snapshot.ref.number} at ${shortSha(snapshot.headSha)}: ${snapshot.state.toLowerCase()}${snapshot.isDraft ? ", draft" : ""}; ${checkSummary(snapshot)}; ${blockerSummary(snapshot)}; ${isGitHubPullRequestReady(snapshot) ? "merge-ready" : "not merge-ready"}.`,
  ];
  if (failing.length > 0) {
    lines.push(
      `Failing checks: ${failing.map((check) => check.name).join(", ")}.`,
    );
  }
  const unresolved = unresolvedThreads(snapshot).slice(0, 5);
  for (const thread of unresolved) {
    const comment = thread.comments.at(-1);
    if (!comment) continue;
    lines.push(
      `Unresolved review thread${comment.outdated ? " (outdated)" : ""}: ${comment.url}`,
    );
  }
  return lines.join("\n");
}
