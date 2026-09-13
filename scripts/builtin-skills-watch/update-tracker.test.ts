import { describe, expect, test } from "bun:test";
import type { BuiltinSkillWatchAnalysis } from "./analysis.ts";
import {
  assertAnalysisIdentity,
  type PullRequestView,
  parseReviewResult,
  type TrackerIssueView,
  validatePullRequestView,
  validateReconciledPullRequestView,
  validateTrackerIssueView,
} from "./update-tracker.ts";

const URL = "https://github.com/letta-ai/letta-code/pull/123";
const CANDIDATE = "creating-skills@aaaaaaaaaaaa-abcdef0123456789";
const LOGIN = "watcher-agent";

describe("watcher PR validation", () => {
  test("accepts an open draft with the exact candidate marker", () => {
    expect(() =>
      validatePullRequestView(validPullRequest(), URL, analysis(), LOGIN),
    ).not.toThrow();
  });

  test("rejects the wrong author", () => {
    expect(() =>
      validatePullRequestView(
        validPullRequest({ author: { login: "someone-else" } }),
        URL,
        analysis(),
        LOGIN,
      ),
    ).toThrow("does not match");
  });

  test("rejects a ready or closed PR", () => {
    expect(() =>
      validatePullRequestView(
        validPullRequest({ isDraft: false }),
        URL,
        analysis(),
        LOGIN,
      ),
    ).toThrow("open and draft");
    expect(() =>
      validatePullRequestView(
        validPullRequest({ state: "CLOSED" }),
        URL,
        analysis(),
        LOGIN,
      ),
    ).toThrow("open and draft");
  });

  test("rejects a PR without the exact candidate marker", () => {
    expect(() =>
      validatePullRequestView(
        validPullRequest({ body: "Builtin-skill-watch: another-candidate" }),
        URL,
        analysis(),
        LOGIN,
      ),
    ).toThrow("missing Builtin-skill-watch");
  });

  test("rejects the wrong base or unrelated files", () => {
    expect(() =>
      validatePullRequestView(
        validPullRequest({ baseRefName: "release" }),
        URL,
        analysis(),
        LOGIN,
      ),
    ).toThrow("target main");
    expect(() =>
      validatePullRequestView(
        validPullRequest({ files: [{ path: "src/cli/args.ts" }] }),
        URL,
        analysis(),
        LOGIN,
      ),
    ).toThrow("outside the selected skill scope");
  });

  test("accepts a merged exact-candidate PR only during reconciliation", () => {
    const merged = validPullRequest({
      isDraft: false,
      mergedAt: "2026-08-27T00:00:00Z",
      state: "MERGED",
    });

    expect(() =>
      validateReconciledPullRequestView(merged, URL, analysis(), LOGIN),
    ).not.toThrow();
    expect(() =>
      validatePullRequestView(merged, URL, analysis(), LOGIN),
    ).toThrow("open and draft");
  });
});

describe("watcher analysis validation", () => {
  test("rejects a changed inventory even when the candidate ID is unchanged", () => {
    const rebuilt = analysis();
    const received = {
      ...rebuilt,
      skill_inventory: ["creating-skills"],
    };

    expect(() => assertAnalysisIdentity(received, rebuilt)).toThrow(
      "skill_inventory",
    );
  });

  test("rejects a changed skill digest", () => {
    const rebuilt = analysis();
    const received = { ...rebuilt, skill_digest: "f".repeat(64) };

    expect(() => assertAnalysisIdentity(received, rebuilt)).toThrow(
      "skill_digest",
    );
  });
});

describe("watcher result validation", () => {
  test("accepts a terminal result bound to the candidate", () => {
    const current = analysis();
    const result = parseReviewResult(
      {
        schema_version: 1,
        candidate_id: current.candidate_id,
        skill: current.skill,
        outcome: "no_drift",
        notes: "current source and docs agree",
        pr_url: null,
        evidence: evidence(current),
      },
      current,
    );

    expect(result.outcome).toBe("no_drift");
  });

  test("rejects extra fields and PR URL mismatches", () => {
    const current = analysis();
    const base = {
      schema_version: 1,
      candidate_id: current.candidate_id,
      skill: current.skill,
      outcome: "no_drift",
      notes: "current source and docs agree",
      pr_url: null,
      evidence: evidence(current),
    };
    expect(() => parseReviewResult({ ...base, secret: "no" }, current)).toThrow(
      "unknown or missing fields",
    );
    expect(() =>
      parseReviewResult(
        { ...base, pr_url: "https://github.com/letta-ai/letta-code/pull/1" },
        current,
      ),
    ).toThrow("PR URL does not match");
  });
});

describe("watcher tracker validation", () => {
  test("accepts only the open Actions-owned tracker", () => {
    const tracker = trackerIssue();
    expect(() => validateTrackerIssueView(tracker)).not.toThrow();
    expect(() =>
      validateTrackerIssueView({ ...tracker, state: "CLOSED" }),
    ).toThrow("closed or invalid");
    expect(() =>
      validateTrackerIssueView({
        ...tracker,
        author: { login: "someone-else" },
      }),
    ).toThrow("closed or invalid");
  });
});

function validPullRequest(
  overrides: Partial<PullRequestView> = {},
): PullRequestView {
  return {
    author: { login: LOGIN },
    baseRefName: "main",
    body: `Builtin-skill-watch: ${CANDIDATE}`,
    files: [
      { path: "src/skills/builtin/creating-skills/SKILL.md" },
      { path: "src/agent/skills-discovery.test.ts" },
    ],
    headRefOid: "c".repeat(40),
    isDraft: true,
    state: "OPEN",
    url: URL,
    ...overrides,
  };
}

function analysis(): BuiltinSkillWatchAnalysis {
  return {
    schema_version: 1,
    candidate_id: CANDIDATE,
    skill: "creating-skills",
    skill_path: "src/skills/builtin/creating-skills",
    skill_files: ["src/skills/builtin/creating-skills/SKILL.md"],
    skill_digest: "b".repeat(64),
    current_sha: "a".repeat(40),
    audit_at: "2026-08-26T00:00:00.000Z",
    previous_audit: null,
    repository_changes: {
      previous_sha: null,
      changed_files: [],
      commits: [],
      history_available: false,
      truncated: false,
    },
    skill_inventory: ["creating-skills", "syncing-memory-filesystem"],
    workflow_run_url: "https://github.com/letta-ai/letta-code/actions/runs/1",
  };
}

function evidence(current: BuiltinSkillWatchAnalysis) {
  return {
    schema_version: 1,
    candidate_id: current.candidate_id,
    skill: current.skill,
    sources: [
      {
        locator: current.skill_path,
        revision: current.current_sha,
        content_digest: current.skill_digest,
        retrieved_at: current.audit_at,
        excerpt: "the skill claim matches current source",
        claims: ["checked current source"],
      },
    ],
    probes: [],
  };
}

function trackerIssue(): TrackerIssueView {
  return {
    author: { login: "app/github-actions" },
    body: "tracker",
    labels: [{ name: "builtin-skills-watch" }],
    state: "OPEN",
    title: "Built-in skill staleness tracker",
  };
}
