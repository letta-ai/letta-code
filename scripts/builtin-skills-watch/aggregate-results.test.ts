import { describe, expect, test } from "bun:test";
import {
  buildEvidenceCommentBatches,
  type ValidatedOutcome,
} from "./aggregate-results.ts";
import type { BuiltinSkillWatchAnalysis } from "./analysis.ts";
import type { ReviewResult } from "./update-tracker.ts";

describe("daily evidence aggregation", () => {
  test("keeps every evidence comment below GitHub's body limit", () => {
    const outcomes = Array.from({ length: 100 }, (_, index) =>
      outcome(`skill-${index}`, index),
    );
    const batches = buildEvidenceCommentBatches(outcomes);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.candidateIds)).toEqual(
      outcomes.map((entry) => entry.analysis.candidate_id),
    );
    for (const batch of batches) {
      expect(Buffer.byteLength(batch.body, "utf8")).toBeLessThan(60_000);
    }
  });

  test("omits failed reviews that have no evidence", () => {
    const failed = outcome("failed-skill", 1);
    failed.result = null;
    expect(buildEvidenceCommentBatches([failed])).toEqual([]);
  });
});

function outcome(skill: string, index: number): ValidatedOutcome {
  const candidateId = `${skill}@${"a".repeat(12)}-${index.toString(16).padStart(16, "0")}`;
  const analysis: BuiltinSkillWatchAnalysis = {
    schema_version: 1,
    candidate_id: candidateId,
    skill,
    skill_path: `src/skills/builtin/${skill}`,
    skill_files: [`src/skills/builtin/${skill}/SKILL.md`],
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
    skill_inventory: [skill],
    workflow_run_url: "https://github.com/letta-ai/letta-code/actions/runs/1",
  };
  const result: ReviewResult = {
    schema_version: 1,
    candidate_id: candidateId,
    skill,
    outcome: "no_drift",
    notes: "current",
    pr_url: null,
    evidence: {
      schema_version: 1,
      candidate_id: candidateId,
      skill,
      sources: [
        {
          locator: analysis.skill_path,
          revision: analysis.current_sha,
          content_digest: analysis.skill_digest,
          retrieved_at: analysis.audit_at,
          excerpt: "x".repeat(200),
          claims: ["checked current source and documentation"],
        },
      ],
      probes: [],
    },
  };
  return { analysis, result };
}
