import {
  githubPullRequestBlockerSummary,
  githubPullRequestCheckSummary,
  isGitHubPullRequestReady,
  pendingGitHubPullRequestChecks,
  shortGitHubPullRequestSha,
} from "./github-pull-request-state";
import type {
  GitHubPullRequestSnapshot,
  PullRequestCheck,
  PullRequestComment,
  PullRequestInlineComment,
} from "./github-pull-request-types";

const MAX_SUMMARY_BODY_CHARS = 240;

export type PullRequestEventKind =
  | "merged"
  | "closed"
  | "conflict"
  | "checks_done"
  | "review"
  | "comment"
  | "push"
  | "state"
  | "checks";

export interface GitHubPullRequestWatchDiff {
  events: string[];
  terminal: boolean;
}

function normalizedBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_SUMMARY_BODY_CHARS) return compact;
  return `${compact.slice(0, MAX_SUMMARY_BODY_CHARS)}…`;
}

function commentEvent(label: string, comment: PullRequestComment): string {
  const body = normalizedBody(comment.body);
  return `${label} from @${comment.author}: ${body || "(no body)"} ${comment.url}`;
}

function inlineCommentEvent(
  comment: PullRequestInlineComment,
  label = "New inline review comment",
): string {
  const location = comment.path
    ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ""}`
    : "";
  const outdated = comment.outdated ? " (outdated)" : "";
  return `${label} from @${comment.author}${location}${outdated}: ${normalizedBody(comment.body) || "(no body)"} ${comment.url}`;
}

function checkUrl(check: PullRequestCheck): string {
  return check.url ? ` ${check.url}` : "";
}

function matchesCurrentFailure(
  attempt: PullRequestCheck,
  currentFailures: PullRequestCheck[],
): boolean {
  return currentFailures.some((check) =>
    attempt.url && check.url
      ? attempt.url === check.url
      : attempt.name === check.name && attempt.result === check.result,
  );
}

function sameKnownValue(previous: string, current: string): boolean {
  return current === "UNKNOWN" || previous === current;
}

export function diffGitHubPullRequestSnapshots(
  previous: GitHubPullRequestSnapshot,
  current: GitHubPullRequestSnapshot,
  notifyOn?: readonly PullRequestEventKind[],
): GitHubPullRequestWatchDiff {
  const events: string[] = [];
  const add = (kind: PullRequestEventKind, ...lines: string[]) => {
    if (!notifyOn || notifyOn.includes(kind)) events.push(...lines);
  };
  const headChanged = previous.headSha !== current.headSha;

  if (headChanged) {
    add(
      "push",
      `PR head changed from ${shortGitHubPullRequestSha(previous.headSha)} to ${shortGitHubPullRequestSha(current.headSha)}. ${githubPullRequestCheckSummary(current)}; ${githubPullRequestBlockerSummary(current)}.`,
    );
    const currentFailures = current.checks.filter(
      (check) => check.phase === "failure",
    );
    for (const attempt of current.checkAttempts) {
      if (
        attempt.phase === "failure" &&
        !matchesCurrentFailure(attempt, currentFailures)
      ) {
        add(
          "checks",
          `Check attempt failed on new head before the next poll: ${attempt.name} (${attempt.result}).${checkUrl(attempt)}`,
        );
      }
    }
  }

  if (previous.state !== current.state) {
    add(
      current.state === "MERGED" ? "merged" : "closed",
      current.state === "MERGED"
        ? `PR merged at ${shortGitHubPullRequestSha(current.headSha)}: ${current.ref.url}`
        : current.state === "CLOSED"
          ? `PR closed without merge at ${shortGitHubPullRequestSha(current.headSha)}: ${current.ref.url}`
          : `PR reopened at ${shortGitHubPullRequestSha(current.headSha)}: ${current.ref.url}`,
    );
  }

  if (previous.isDraft !== current.isDraft) {
    add(
      "state",
      current.isDraft
        ? "PR moved back to draft."
        : "PR marked ready for review.",
    );
  }

  const previousComments = new Map(
    previous.comments.map((comment) => [comment.id, comment]),
  );
  for (const comment of current.comments) {
    const old = previousComments.get(comment.id);
    if (!old) {
      add("comment", commentEvent("New PR comment", comment));
    } else if (old.updatedAt !== comment.updatedAt) {
      add("comment", commentEvent("PR comment edited", comment));
    }
  }

  const previousReviews = new Map(
    previous.reviews.map((review) => [review.id, review]),
  );
  for (const review of current.reviews) {
    const old = previousReviews.get(review.id);
    if (!old) {
      add(
        "review",
        commentEvent(`New ${review.state.toLowerCase()} review`, review),
      );
    } else if (
      old.state !== review.state ||
      old.updatedAt !== review.updatedAt
    ) {
      add(
        "review",
        commentEvent(`Review changed to ${review.state.toLowerCase()}`, review),
      );
    }
  }

  const previousThreads = new Map(
    previous.reviewThreads.map((thread) => [thread.id, thread]),
  );
  for (const thread of current.reviewThreads) {
    const old = previousThreads.get(thread.id);
    if (old && old.isResolved !== thread.isResolved) {
      const url = thread.comments.at(-1)?.url ?? current.ref.url;
      add(
        "review",
        thread.isResolved
          ? `Review thread resolved: ${url}`
          : `Review thread reopened: ${url}`,
      );
    }
    const oldComments = new Map(
      old?.comments.map((comment) => [comment.id, comment]) ?? [],
    );
    for (const comment of thread.comments) {
      const oldComment = oldComments.get(comment.id);
      if (!oldComment) {
        add("comment", inlineCommentEvent(comment));
      } else {
        if (oldComment.updatedAt !== comment.updatedAt) {
          add(
            "comment",
            inlineCommentEvent(comment, "Inline review comment edited"),
          );
        }
        if (oldComment.outdated !== comment.outdated) {
          add(
            "comment",
            comment.outdated
              ? `Review comment became outdated: ${comment.url}`
              : `Review comment is current again: ${comment.url}`,
          );
        }
      }
    }
  }

  if (!headChanged) {
    const previousChecks = new Map(
      previous.checks.map((check) => [check.key, check]),
    );
    const previousPending = pendingGitHubPullRequestChecks(previous).length;
    const currentPending = pendingGitHubPullRequestChecks(current).length;
    const currentFailures = current.checks.filter(
      (check) => check.phase === "failure",
    );
    for (const check of current.checks) {
      const old = previousChecks.get(check.key);
      if (check.phase === "pending" && old && old.phase !== "pending") {
        add("checks", `Check rerun started: ${check.name}.${checkUrl(check)}`);
      }
      if ((!old || old.phase !== "failure") && check.phase === "failure") {
        add(
          "checks",
          `Check failed: ${check.name} (${check.result}).${checkUrl(check)}`,
        );
      } else if (
        old?.phase === "failure" &&
        (check.phase === "success" || check.phase === "neutral")
      ) {
        add(
          "checks",
          `Check recovered: ${check.name} (${check.result}).${checkUrl(check)}`,
        );
      }
    }
    if (previousPending > 0 && currentPending === 0) {
      add(
        "checks_done",
        `Current-head checks finished: ${githubPullRequestCheckSummary(current)}.`,
      );
    }
    const previousAttempts = new Set(
      previous.checkAttempts.map((attempt) => attempt.key),
    );
    for (const attempt of current.checkAttempts) {
      if (
        attempt.phase === "failure" &&
        !previousAttempts.has(attempt.key) &&
        !matchesCurrentFailure(attempt, currentFailures)
      ) {
        add(
          "checks",
          `Check attempt failed before the next poll: ${attempt.name} (${attempt.result}).${checkUrl(attempt)}`,
        );
      }
    }
  }

  if (!sameKnownValue(previous.mergeable, current.mergeable)) {
    add(
      "conflict",
      current.mergeable === "CONFLICTING"
        ? "PR now has merge conflicts."
        : `PR mergeability changed to ${current.mergeable}.`,
    );
  }
  if (!sameKnownValue(previous.mergeStateStatus, current.mergeStateStatus)) {
    add(
      "state",
      `GitHub merge state changed from ${previous.mergeStateStatus} to ${current.mergeStateStatus}.`,
    );
  }
  if (previous.reviewDecision !== current.reviewDecision) {
    add(
      "review",
      `Review decision changed from ${previous.reviewDecision} to ${current.reviewDecision}.`,
    );
  }
  const wasReady = isGitHubPullRequestReady(previous);
  const isReady = isGitHubPullRequestReady(current);
  if (!wasReady && isReady) {
    add(
      "state",
      `PR is merge-ready on head ${shortGitHubPullRequestSha(current.headSha)} after a fresh read: ${current.ref.url}`,
    );
  } else if (wasReady && !isReady) {
    add(
      "state",
      `PR is no longer merge-ready on head ${shortGitHubPullRequestSha(current.headSha)}: ${githubPullRequestBlockerSummary(current)}; ${githubPullRequestCheckSummary(current)}.`,
    );
  }

  if (
    headChanged &&
    notifyOn?.includes("checks_done") &&
    pendingGitHubPullRequestChecks(current).length === 0
  ) {
    add(
      "checks_done",
      `Current-head checks finished: ${githubPullRequestCheckSummary(current)}.`,
    );
  }

  return {
    events,
    terminal: current.state === "MERGED" || current.state === "CLOSED",
  };
}
