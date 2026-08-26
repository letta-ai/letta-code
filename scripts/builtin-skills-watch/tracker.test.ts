import { describe, expect, test } from "bun:test";
import type { BuiltinSkillWatchAnalysis } from "./analysis.ts";
import type { ReviewEvidence } from "./evidence.ts";
import {
  emptyTrackerState,
  hasTerminalCandidate,
  parseTrackerState,
  recordOutcome,
  renderTrackerBody,
  startCandidate,
} from "./tracker.ts";

const INVENTORY = ["creating-skills", "syncing-memory-filesystem"];

describe("built-in skills tracker", () => {
  test("round trips hidden state and shows never-audited skills", () => {
    const state = emptyTrackerState();
    const body = renderTrackerBody(state, INVENTORY);

    expect(parseTrackerState(body)).toEqual(state);
    expect(body).toContain("| creating-skills | never | - | - | - |");
  });

  test("terminal outcomes advance only the selected skill", () => {
    const analysis = fakeAnalysis("creating-skills", 1);
    const next = recordOutcome(startCandidate(emptyTrackerState(), analysis), {
      analysis,
      outcome: "no_drift",
      notes: "current",
      processedAt: "2026-08-26T01:00:00.000Z",
      evidence: fakeEvidence(analysis),
    });

    expect(next.skills["creating-skills"]).toMatchObject({
      candidate_id: analysis.candidate_id,
      audited_sha: "a".repeat(40),
      outcome: "no_drift",
    });
    expect(next.skills["syncing-memory-filesystem"]).toBeUndefined();
    expect(hasTerminalCandidate(next, analysis.candidate_id)).toBe(true);
  });

  test("errors remain retryable and do not advance the skill audit", () => {
    const analysis = fakeAnalysis("creating-skills", 2);
    const next = recordOutcome(startCandidate(emptyTrackerState(), analysis), {
      analysis,
      outcome: "error",
      notes: "action failed",
      processedAt: "2026-08-26T01:00:00.000Z",
    });

    expect(next.skills["creating-skills"]).toBeUndefined();
    expect(next.history[0]?.outcome).toBe("error");
    expect(hasTerminalCandidate(next, analysis.candidate_id)).toBe(false);
    expect(next.pending?.candidate_id).toBe(analysis.candidate_id);
    expect(startCandidate(next, analysis)).toEqual(next);
    expect(parseTrackerState(renderTrackerBody(next, INVENTORY))).toEqual(next);
  });

  test("a terminal retry replaces the same candidate history entry", () => {
    const analysis = fakeAnalysis("creating-skills", 3);
    const failed = recordOutcome(
      startCandidate(emptyTrackerState(), analysis),
      {
        analysis,
        outcome: "error",
        notes: "failed",
        processedAt: "2026-08-26T01:00:00.000Z",
      },
    );
    const recovered = recordOutcome(failed, {
      analysis,
      outcome: "pr_created",
      notes: "fixed",
      prUrl: "https://github.com/letta-ai/letta-code/pull/1",
      processedAt: "2026-08-26T02:00:00.000Z",
      evidence: fakeEvidence(analysis),
    });

    expect(recovered.history).toHaveLength(1);
    expect(recovered.history[0]?.outcome).toBe("pr_created");
    expect(recovered.skills["creating-skills"]?.pr_url).toBe(
      "https://github.com/letta-ai/letta-code/pull/1",
    );
  });

  test("keeps history bounded", () => {
    let state = emptyTrackerState();
    for (let index = 0; index < 60; index += 1) {
      const analysis = fakeAnalysis("creating-skills", index);
      state = startCandidate(state, analysis);
      state = recordOutcome(state, {
        analysis,
        outcome: "no_drift",
        notes: "current",
        processedAt: `2026-08-${String((index % 26) + 1).padStart(2, "0")}T00:00:00.000Z`,
        evidence: fakeEvidence(analysis),
      });
    }

    expect(state.history).toHaveLength(10);
    expect(state.history[0]?.candidate_id).toBe(
      fakeAnalysis("creating-skills", 59).candidate_id,
    );
  });

  test("rejects malformed hidden state", () => {
    expect(() =>
      parseTrackerState("<!-- builtin-skills-agent-watch-state\n{}\n-->"),
    ).toThrow("hidden state is invalid");
  });

  test("does not let a later error replace a terminal outcome", () => {
    const analysis = fakeAnalysis("creating-skills", 4);
    const terminal = recordOutcome(
      startCandidate(emptyTrackerState(), analysis),
      {
        analysis,
        outcome: "no_drift",
        notes: "current",
        evidence: fakeEvidence(analysis),
        processedAt: "2026-08-26T01:00:00.000Z",
      },
    );
    const afterError = recordOutcome(terminal, {
      analysis,
      outcome: "error",
      notes: "late failure",
      processedAt: "2026-08-26T02:00:00.000Z",
    });

    expect(afterError).toEqual(terminal);
    expect(afterError.history[0]?.outcome).toBe("no_drift");
  });

  test("keeps a full skill rotation below the issue body limit", () => {
    let state = emptyTrackerState();
    const inventory: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const skill = `skill-${index}`;
      inventory.push(skill);
      const analysis = fakeAnalysis(skill, index);
      state = startCandidate(state, analysis);
      state = recordOutcome(state, {
        analysis,
        outcome: "no_drift",
        notes: "n".repeat(200),
        evidence: fakeEvidence(analysis),
        processedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    const body = renderTrackerBody(state, inventory);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(60_000);
  });
});

function fakeAnalysis(
  skill: string,
  candidateNumber: number,
): BuiltinSkillWatchAnalysis {
  const candidateId = `${skill}@aaaaaaaaaaaa-${candidateNumber.toString(16).padStart(16, "0")}`;
  return {
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
    skill_inventory: INVENTORY,
    workflow_run_url: "https://github.com/letta-ai/letta-code/actions/runs/1",
  };
}

function fakeEvidence(analysis: BuiltinSkillWatchAnalysis): ReviewEvidence {
  return {
    schema_version: 1,
    candidate_id: analysis.candidate_id,
    skill: analysis.skill,
    sources: [
      {
        locator: analysis.skill_path,
        revision: analysis.current_sha,
        content_digest: analysis.skill_digest,
        retrieved_at: analysis.audit_at,
        excerpt: "the selected skill matches its current owning source",
        claims: ["skill files reviewed against current source"],
      },
    ],
    probes: [],
  };
}
