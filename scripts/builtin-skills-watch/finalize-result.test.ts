import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuiltinSkillWatchAnalysis } from "./analysis.ts";

describe("review result finalization", () => {
  test("validates with the runner parser before encoding the result", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-result-finalizer-"));
    try {
      const analysis = fakeAnalysis();
      const analysisFile = join(directory, "analysis.json");
      const resultFile = join(directory, "result.json");
      writeFileSync(analysisFile, JSON.stringify(analysis));
      writeFileSync(resultFile, JSON.stringify(fakeResult(analysis)));

      const finalized = Bun.spawnSync([
        "bun",
        "scripts/builtin-skills-watch/finalize-result.ts",
        "--analysis-file",
        analysisFile,
        "--result-file",
        resultFile,
      ]);

      expect(finalized.exitCode).toBe(0);
      const line = finalized.stdout.toString().trim();
      expect(line).toStartWith("SKILL_WATCH_RESULT ");
      expect(
        JSON.parse(
          Buffer.from(
            line.slice("SKILL_WATCH_RESULT ".length),
            "base64",
          ).toString("utf8"),
        ),
      ).toEqual(fakeResult(analysis));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a result for another candidate", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-result-finalizer-"));
    try {
      const analysis = fakeAnalysis();
      const analysisFile = join(directory, "analysis.json");
      const resultFile = join(directory, "result.json");
      writeFileSync(analysisFile, JSON.stringify(analysis));
      writeFileSync(
        resultFile,
        JSON.stringify({
          ...fakeResult(analysis),
          candidate_id: "creating-skills@bbbbbbbbbbbb-abcdef0123456789",
        }),
      );

      const finalized = Bun.spawnSync([
        "bun",
        "scripts/builtin-skills-watch/finalize-result.ts",
        "--analysis-file",
        analysisFile,
        "--result-file",
        resultFile,
      ]);

      expect(finalized.exitCode).not.toBe(0);
      expect(finalized.stderr.toString()).toContain(
        "does not match the pending candidate",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function fakeAnalysis(): BuiltinSkillWatchAnalysis {
  const skill = "creating-skills";
  return {
    schema_version: 1,
    candidate_id: `${skill}@${"a".repeat(12)}-abcdef0123456789`,
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
}

function fakeResult(analysis: BuiltinSkillWatchAnalysis) {
  return {
    schema_version: 1,
    candidate_id: analysis.candidate_id,
    skill: analysis.skill,
    outcome: "no_drift",
    notes: "current source and skill agree",
    pr_url: null,
    evidence: {
      schema_version: 1,
      candidate_id: analysis.candidate_id,
      skill: analysis.skill,
      sources: [
        {
          locator: analysis.skill_path,
          revision: analysis.current_sha,
          content_digest: analysis.skill_digest,
          retrieved_at: analysis.audit_at,
          excerpt: "the current skill matches its owning source",
          claims: ["checked current source"],
        },
      ],
      probes: [],
    },
  } as const;
}
