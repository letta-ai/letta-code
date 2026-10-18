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
  readinessConfirmed: boolean;
  checks: PullRequestCheck[];
  checkAttempts: PullRequestCheck[];
  comments: PullRequestComment[];
  reviews: PullRequestReview[];
  reviewThreads: PullRequestReviewThread[];
}
