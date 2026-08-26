import { describe, expect, test } from "bun:test";
import { digestReviewEvidence, parseReviewEvidence } from "./evidence.ts";

describe("review evidence", () => {
  test("accepts bounded source and probe evidence", () => {
    const evidence = parseReviewEvidence({
      schema_version: 1,
      candidate_id: "creating-skills@abc-candidate",
      skill: "creating-skills",
      sources: [
        {
          locator: "src/skills/builtin/creating-skills/SKILL.md",
          revision: "a".repeat(40),
          content_digest: "b".repeat(64),
          retrieved_at: "2026-08-26T00:00:00.000Z",
          excerpt: "name must match the skill directory",
          claims: ["frontmatter rules match the validator"],
        },
      ],
      probes: [
        {
          command: "bun test src/skills/builtin/creating-skills",
          result_digest: "c".repeat(64),
          summary: "validator tests passed",
        },
      ],
    });

    expect(digestReviewEvidence(evidence)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("requires at least one source", () => {
    expect(() =>
      parseReviewEvidence({
        schema_version: 1,
        candidate_id: "candidate",
        skill: "creating-skills",
        sources: [],
        probes: [],
      }),
    ).toThrow("sources are invalid");
  });

  test("rejects malformed digests and timestamps", () => {
    expect(() =>
      parseReviewEvidence({
        schema_version: 1,
        candidate_id: "candidate",
        skill: "creating-skills",
        sources: [
          {
            locator: "https://docs.letta.com/",
            revision: null,
            content_digest: "not-a-digest",
            retrieved_at: "yesterday",
            excerpt: "current docs text",
            claims: ["checked docs"],
          },
        ],
        probes: [],
      }),
    ).toThrow("sources are invalid");
  });

  test("rejects evidence too large for the tracker", () => {
    expect(() =>
      parseReviewEvidence({
        schema_version: 1,
        candidate_id: "candidate",
        skill: "creating-skills",
        sources: [
          {
            locator: "x".repeat(500),
            revision: "y".repeat(300),
            content_digest: null,
            retrieved_at: "2026-08-26T00:00:00.000Z",
            excerpt: "q".repeat(300),
            claims: ["z".repeat(500)],
          },
        ],
        probes: [],
      }),
    ).toThrow("exceeds 650 bytes");
  });

  test("requires a revision or digest and rejects unknown fields", () => {
    const source = {
      locator: "https://docs.letta.com/",
      revision: null,
      content_digest: null,
      retrieved_at: "2026-08-26T00:00:00.000Z",
      excerpt: "current docs text",
      claims: ["checked docs"],
    };
    expect(() =>
      parseReviewEvidence({
        schema_version: 1,
        candidate_id: "candidate",
        skill: "creating-skills",
        sources: [source],
        probes: [],
      }),
    ).toThrow("sources are invalid");
    expect(() =>
      parseReviewEvidence({
        schema_version: 1,
        candidate_id: "candidate",
        skill: "creating-skills",
        sources: [{ ...source, content_digest: "a".repeat(64), secret: "no" }],
        probes: [],
      }),
    ).toThrow("sources are invalid");
  });
});
