import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverReviewArtifacts,
  formatFailureReceipt,
} from "./result-artifacts.ts";

const CANDIDATE = "creating-skills@aaaaaaaaaaaa-abcdef0123456789";

describe("review artifact discovery", () => {
  test("finds both nested and root-level result artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-artifacts-"));
    try {
      const nested = join(directory, "builtin-skill-result-creating-skills");
      mkdirSync(nested);
      writeFileSync(
        join(nested, "result.json"),
        JSON.stringify({ candidate_id: CANDIDATE }),
      );

      const discovered = discoverReviewArtifacts(directory);
      expect(discovered.results.get(CANDIDATE)).toBe(
        join(nested, "result.json"),
      );

      rmSync(nested, { recursive: true });
      writeFileSync(
        join(directory, "result.json"),
        JSON.stringify({ candidate_id: CANDIDATE }),
      );
      expect(discoverReviewArtifacts(directory).results.get(CANDIDATE)).toBe(
        join(directory, "result.json"),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preserves a runner-authored failure receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-artifacts-"));
    try {
      writeFileSync(
        join(directory, "failure.json"),
        JSON.stringify({
          schema_version: 1,
          candidate_id: CANDIDATE,
          skill: "creating-skills",
          kind: "action_failed",
          message: "Letta Code Action failed before returning a result",
          conversation_id: "conv-123",
        }),
      );

      const receipt =
        discoverReviewArtifacts(directory).failures.get(CANDIDATE);
      expect(receipt).toBeDefined();
      expect(formatFailureReceipt(receipt!)).toContain("conversation conv-123");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects duplicate results for one candidate", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-artifacts-"));
    try {
      mkdirSync(join(directory, "first"));
      mkdirSync(join(directory, "second"));
      for (const subdirectory of ["first", "second"]) {
        writeFileSync(
          join(directory, subdirectory, "result.json"),
          JSON.stringify({ candidate_id: CANDIDATE }),
        );
      }
      expect(() => discoverReviewArtifacts(directory)).toThrow(
        `duplicate review result for ${CANDIDATE}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
