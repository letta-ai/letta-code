import type {
  GitHubPullRequestSnapshot,
  PullRequestCheck,
  PullRequestReviewThread,
} from "./github-pull-request-types";

export function shortGitHubPullRequestSha(sha: string): string {
  return sha.slice(0, 12);
}

export function pendingGitHubPullRequestChecks(
  snapshot: GitHubPullRequestSnapshot,
): PullRequestCheck[] {
  return snapshot.checks.filter((check) => check.phase === "pending");
}

export function failedGitHubPullRequestChecks(
  snapshot: GitHubPullRequestSnapshot,
): PullRequestCheck[] {
  return snapshot.checks.filter((check) => check.phase === "failure");
}

export function unresolvedGitHubPullRequestThreads(
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
    snapshot.mergeable === "MERGEABLE" &&
    snapshot.mergeStateStatus === "CLEAN" &&
    (snapshot.reviewDecision === "NONE" ||
      snapshot.reviewDecision === "APPROVED") &&
    pendingGitHubPullRequestChecks(snapshot).length === 0 &&
    failedGitHubPullRequestChecks(snapshot).length === 0 &&
    unresolvedGitHubPullRequestThreads(snapshot).length === 0
  );
}

export function isGitHubPullRequestReady(
  snapshot: GitHubPullRequestSnapshot,
): boolean {
  return (
    snapshot.readinessConfirmed && hasGitHubPullRequestReadyConditions(snapshot)
  );
}

export function githubPullRequestCheckSummary(
  snapshot: GitHubPullRequestSnapshot,
): string {
  const pending = pendingGitHubPullRequestChecks(snapshot).length;
  const failed = failedGitHubPullRequestChecks(snapshot).length;
  const completed = snapshot.checks.length - pending;
  if (snapshot.checks.length === 0) return "no checks reported";
  return `${completed}/${snapshot.checks.length} checks complete, ${failed} failing, ${pending} pending`;
}

export function githubPullRequestBlockerSummary(
  snapshot: GitHubPullRequestSnapshot,
): string {
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
  if (
    hasGitHubPullRequestReadyConditions(snapshot) &&
    !snapshot.readinessConfirmed
  ) {
    blockers.push("awaiting a second same-head readiness read");
  }
  const unresolved = unresolvedGitHubPullRequestThreads(snapshot).length;
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
  const failing = failedGitHubPullRequestChecks(snapshot);
  const lines = [
    `${snapshot.ref.owner}/${snapshot.ref.repo}#${snapshot.ref.number} at ${shortGitHubPullRequestSha(snapshot.headSha)}: ${snapshot.state.toLowerCase()}${snapshot.isDraft ? ", draft" : ""}; ${githubPullRequestCheckSummary(snapshot)}; ${githubPullRequestBlockerSummary(snapshot)}; ${isGitHubPullRequestReady(snapshot) ? "merge-ready" : "not merge-ready"}.`,
  ];
  if (failing.length > 0) {
    lines.push(
      `Failing checks: ${failing.map((check) => check.name).join(", ")}.`,
    );
  }
  const unresolved = unresolvedGitHubPullRequestThreads(snapshot).slice(0, 5);
  for (const thread of unresolved) {
    const comment = thread.comments.at(-1);
    if (!comment) continue;
    lines.push(
      `Unresolved review thread${comment.outdated ? " (outdated)" : ""}: ${comment.url}`,
    );
  }
  return lines.join("\n");
}
