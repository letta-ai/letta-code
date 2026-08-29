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

  test("accepts RFC 3339 UTC timestamps without milliseconds", () => {
    expect(() =>
      parseReviewEvidence({
        schema_version: 1,
        candidate_id: "candidate",
        skill: "creating-skills",
        sources: [
          {
            locator: "src/skills/builtin/creating-skills/SKILL.md",
            revision: "a".repeat(40),
            content_digest: null,
            retrieved_at: "2026-08-26T00:00:00Z",
            excerpt: "current source",
            claims: ["checked current source"],
          },
        ],
        probes: [],
      }),
    ).not.toThrow();
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
    ).toThrow("between 1 and 5 sources");
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
    ).toThrow("content_digest is invalid");
  });

  test("accepts production-sized evidence larger than the old tracker limit", () => {
    const evidence = parseReviewEvidence({
      schema_version: 1,
      candidate_id: "candidate",
      skill: "creating-skills",
      sources: Array.from({ length: 5 }, (_, index) => ({
        locator: `https://docs.letta.com/source-${index}`,
        revision: "a".repeat(40),
        content_digest: "b".repeat(64),
        retrieved_at: "2026-08-26T00:00:00.000Z",
        excerpt: "q".repeat(300),
        claims: Array.from({ length: 5 }, () => "z".repeat(300)),
      })),
      probes: [],
    });

    expect(Buffer.byteLength(JSON.stringify(evidence), "utf8")).toBeGreaterThan(
      650,
    );
  });

  test("still rejects evidence larger than an issue comment can safely hold", () => {
    expect(() =>
      parseReviewEvidence({
        schema_version: 1,
        candidate_id: "candidate",
        skill: "creating-skills",
        sources: Array.from({ length: 5 }, (_, index) => ({
          locator: `https://docs.letta.com/${"x".repeat(450)}-${index}`,
          revision: "y".repeat(300),
          content_digest: null,
          retrieved_at: "2026-08-26T00:00:00.000Z",
          excerpt: "q".repeat(300),
          claims: Array.from({ length: 5 }, () => "z".repeat(500)),
        })),
        probes: Array.from({ length: 5 }, () => ({
          command: "c".repeat(500),
          result_digest: "d".repeat(64),
          summary: "s".repeat(500),
        })),
      }),
    ).toThrow("exceeds 16384 bytes");
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
    ).toThrow("requires a revision or content_digest");
    expect(() =>
      parseReviewEvidence({
        schema_version: 1,
        candidate_id: "candidate",
        skill: "creating-skills",
        sources: [{ ...source, content_digest: "a".repeat(64), secret: "no" }],
        probes: [],
      }),
    ).toThrow("unknown or missing fields");
  });
});
