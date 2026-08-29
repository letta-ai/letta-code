import { describe, expect, test } from "bun:test";
import {
  type CandidatePullRequest,
  selectCanonicalPullRequest,
} from "./reconcile-results.ts";

describe("pending watcher PR reconciliation", () => {
  test("prefers a merged PR and closes every open duplicate", () => {
    const merged = pullRequest(4067, "MERGED");
    const firstDuplicate = pullRequest(4077, "OPEN");
    const secondDuplicate = pullRequest(4099, "OPEN");

    expect(
      selectCanonicalPullRequest([firstDuplicate, secondDuplicate, merged]),
    ).toEqual({
      canonical: merged,
      duplicateOpen: [firstDuplicate, secondDuplicate],
    });
  });

  test("uses the oldest open PR when no candidate was merged", () => {
    const older = pullRequest(4078, "OPEN");
    const newer = pullRequest(4098, "OPEN");

    expect(selectCanonicalPullRequest([newer, older])).toEqual({
      canonical: older,
      duplicateOpen: [newer],
    });
  });

  test("ignores closed unmerged PRs and rejects multiple merged PRs", () => {
    expect(selectCanonicalPullRequest([pullRequest(1, "CLOSED")])).toEqual({
      canonical: null,
      duplicateOpen: [],
    });
    expect(() =>
      selectCanonicalPullRequest([
        pullRequest(1, "MERGED"),
        pullRequest(2, "MERGED"),
      ]),
    ).toThrow("Multiple merged watcher PRs");
  });
});

function pullRequest(number: number, state: string): CandidatePullRequest {
  return {
    number,
    author: { login: "amelia-letta" },
    baseRefName: "main",
    body: "Builtin-skill-watch: creating-skills@aaaaaaaaaaaa-0000000000000001",
    files: [{ path: "src/skills/builtin/creating-skills/SKILL.md" }],
    headRefOid: number.toString(16).padStart(40, "0"),
    isDraft: state === "OPEN",
    mergedAt: state === "MERGED" ? "2026-08-27T00:00:00Z" : null,
    state,
    url: `https://github.com/letta-ai/letta-code/pull/${number}`,
  };
}
