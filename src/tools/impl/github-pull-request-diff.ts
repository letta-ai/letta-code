import {
  type GitHubPullRequestSnapshot,
  hasGitHubPullRequestReadyConditions,
  isGitHubPullRequestReady,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestInlineComment,
} from "./github-pull-request-watch";

const MAX_SUMMARY_BODY_CHARS = 240;

export interface GitHubPullRequestWatchDiff {
  events: string[];
  terminal: boolean;
}

function normalizedBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_SUMMARY_BODY_CHARS) return compact;
  return `${compact.slice(0, MAX_SUMMARY_BODY_CHARS)}…`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function pendingChecks(
  snapshot: GitHubPullRequestSnapshot,
): PullRequestCheck[] {
  return snapshot.checks.filter((check) => check.phase === "pending");
}

function checkSummary(snapshot: GitHubPullRequestSnapshot): string {
  const pending = pendingChecks(snapshot).length;
  const failed = snapshot.checks.filter(
    (check) => check.phase === "failure",
  ).length;
  const completed = snapshot.checks.length - pending;
  if (snapshot.checks.length === 0) return "no checks reported";
  return `${completed}/${snapshot.checks.length} checks complete, ${failed} failing, ${pending} pending`;
}

function unresolvedThreadCount(snapshot: GitHubPullRequestSnapshot): number {
  return snapshot.reviewThreads.filter((thread) => !thread.isResolved).length;
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
  const unresolved = unresolvedThreadCount(snapshot);
  if (unresolved > 0) {
    blockers.push(
      `${unresolved} unresolved review thread${unresolved === 1 ? "" : "s"}`,
    );
  }
  return blockers.length > 0 ? blockers.join(", ") : "no known blockers";
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
): GitHubPullRequestWatchDiff {
  const events: string[] = [];
  const headChanged = previous.headSha !== current.headSha;

  if (headChanged) {
    events.push(
      `PR head changed from ${shortSha(previous.headSha)} to ${shortSha(current.headSha)}. ${checkSummary(current)}; ${blockerSummary(current)}.`,
    );
    const currentFailures = current.checks.filter(
      (check) => check.phase === "failure",
    );
    for (const attempt of current.checkAttempts) {
      if (
        attempt.phase === "failure" &&
        !matchesCurrentFailure(attempt, currentFailures)
      ) {
        events.push(
          `Check attempt failed on new head before the next poll: ${attempt.name} (${attempt.result}).${checkUrl(attempt)}`,
        );
      }
    }
  }

  if (previous.state !== current.state) {
    events.push(
      current.state === "MERGED"
        ? `PR merged at ${shortSha(current.headSha)}: ${current.ref.url}`
        : current.state === "CLOSED"
          ? `PR closed without merge at ${shortSha(current.headSha)}: ${current.ref.url}`
          : `PR reopened at ${shortSha(current.headSha)}: ${current.ref.url}`,
    );
  }

  if (previous.isDraft !== current.isDraft) {
    events.push(
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
      events.push(commentEvent("New PR comment", comment));
    } else if (old.updatedAt !== comment.updatedAt) {
      events.push(commentEvent("PR comment edited", comment));
    }
  }

  const previousReviews = new Map(
    previous.reviews.map((review) => [review.id, review]),
  );
  for (const review of current.reviews) {
    const old = previousReviews.get(review.id);
    if (!old) {
      events.push(
        commentEvent(`New ${review.state.toLowerCase()} review`, review),
      );
    } else if (
      old.state !== review.state ||
      old.updatedAt !== review.updatedAt
    ) {
      events.push(
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
      events.push(
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
        events.push(inlineCommentEvent(comment));
      } else {
        if (oldComment.updatedAt !== comment.updatedAt) {
          events.push(
            inlineCommentEvent(comment, "Inline review comment edited"),
          );
        }
        if (oldComment.outdated !== comment.outdated) {
          events.push(
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
    const previousPending = pendingChecks(previous).length;
    const currentPending = pendingChecks(current).length;
    const startedChecks: string[] = [];
    const currentFailures = current.checks.filter(
      (check) => check.phase === "failure",
    );
    for (const check of current.checks) {
      const old = previousChecks.get(check.key);
      if (check.phase === "pending" && old?.phase !== "pending") {
        startedChecks.push(
          old ? `${check.name} (rerun)` : `${check.name} (new)`,
        );
      }
      if ((!old || old.phase !== "failure") && check.phase === "failure") {
        events.push(
          `Check failed: ${check.name} (${check.result}).${checkUrl(check)}`,
        );
      } else if (
        old?.phase === "failure" &&
        (check.phase === "success" || check.phase === "neutral")
      ) {
        events.push(
          `Check recovered: ${check.name} (${check.result}).${checkUrl(check)}`,
        );
      }
    }
    if (startedChecks.length > 0) {
      events.push(`Checks started: ${startedChecks.join(", ")}.`);
    }
    if (previousPending > 0 && currentPending === 0) {
      events.push(`Current-head checks finished: ${checkSummary(current)}.`);
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
        events.push(
          `Check attempt failed before the next poll: ${attempt.name} (${attempt.result}).${checkUrl(attempt)}`,
        );
      }
    }
  }

  if (!sameKnownValue(previous.mergeable, current.mergeable)) {
    events.push(
      current.mergeable === "CONFLICTING"
        ? "PR now has merge conflicts."
        : `PR mergeability changed to ${current.mergeable}.`,
    );
  }
  if (!sameKnownValue(previous.mergeStateStatus, current.mergeStateStatus)) {
    events.push(
      `GitHub merge state changed from ${previous.mergeStateStatus} to ${current.mergeStateStatus}.`,
    );
  }
  if (previous.reviewDecision !== current.reviewDecision) {
    events.push(
      `Review decision changed from ${previous.reviewDecision} to ${current.reviewDecision}.`,
    );
  }
  if (previous.snapshotComplete !== current.snapshotComplete) {
    events.push(
      current.snapshotComplete
        ? "GitHub snapshot coverage returned to a complete page."
        : "GitHub snapshot exceeded a 100-item page; merge readiness is now fail-closed.",
    );
  }

  const wasReady = isGitHubPullRequestReady(previous);
  const isReady = isGitHubPullRequestReady(current);
  if (!wasReady && isReady) {
    events.push(
      `PR is merge-ready on head ${shortSha(current.headSha)} after a fresh read: ${current.ref.url}`,
    );
  } else if (wasReady && !isReady) {
    events.push(
      `PR is no longer merge-ready on head ${shortSha(current.headSha)}: ${blockerSummary(current)}; ${checkSummary(current)}.`,
    );
  }

  return {
    events,
    terminal: current.state === "MERGED" || current.state === "CLOSED",
  };
}
