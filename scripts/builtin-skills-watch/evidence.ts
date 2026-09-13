import { createHash } from "node:crypto";

const MAX_SOURCES = 5;
const MAX_PROBES = 5;
const MAX_CLAIMS_PER_SOURCE = 5;
const MAX_SERIALIZED_BYTES = 16 * 1024;

export interface EvidenceSource {
  locator: string;
  revision: string | null;
  content_digest: string | null;
  retrieved_at: string;
  excerpt: string;
  claims: string[];
}

export interface EvidenceProbe {
  command: string;
  result_digest: string;
  summary: string;
}

export interface ReviewEvidence {
  schema_version: 1;
  candidate_id: string;
  skill: string;
  sources: EvidenceSource[];
  probes: EvidenceProbe[];
}

export function parseReviewEvidence(value: unknown): ReviewEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema_version",
      "candidate_id",
      "skill",
      "sources",
      "probes",
    ]) ||
    value.schema_version !== 1
  ) {
    throw new TypeError("review evidence must use schema version 1");
  }
  if (!isBoundedString(value.candidate_id, 300)) {
    throw new TypeError("review evidence candidate_id is invalid");
  }
  if (!isBoundedString(value.skill, 100)) {
    throw new TypeError("review evidence skill is invalid");
  }
  if (
    !Array.isArray(value.sources) ||
    value.sources.length === 0 ||
    value.sources.length > MAX_SOURCES
  ) {
    throw new TypeError("review evidence must include between 1 and 5 sources");
  }
  if (!Array.isArray(value.probes) || value.probes.length > MAX_PROBES) {
    throw new TypeError("review evidence must include at most 5 probes");
  }
  const evidence: ReviewEvidence = {
    schema_version: 1,
    candidate_id: value.candidate_id,
    skill: value.skill,
    sources: value.sources.map(parseEvidenceSource),
    probes: value.probes.map(parseEvidenceProbe),
  };
  if (
    Buffer.byteLength(JSON.stringify(evidence), "utf8") > MAX_SERIALIZED_BYTES
  ) {
    throw new TypeError("review evidence exceeds 16384 bytes");
  }
  return evidence;
}

export function digestReviewEvidence(evidence: ReviewEvidence): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

function parseEvidenceSource(value: unknown, index: number): EvidenceSource {
  const description = `review evidence source ${index + 1}`;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "locator",
      "revision",
      "content_digest",
      "retrieved_at",
      "excerpt",
      "claims",
    ])
  ) {
    throw new TypeError(`${description} has unknown or missing fields`);
  }
  if (!isBoundedString(value.locator, 500)) {
    throw new TypeError(`${description} locator is invalid`);
  }
  if (value.revision !== null && !isBoundedString(value.revision, 300)) {
    throw new TypeError(`${description} revision is invalid`);
  }
  if (value.content_digest !== null && !isDigest(value.content_digest)) {
    throw new TypeError(`${description} content_digest is invalid`);
  }
  if (value.revision === null && value.content_digest === null) {
    throw new TypeError(`${description} requires a revision or content_digest`);
  }
  if (!isIsoTimestamp(value.retrieved_at)) {
    throw new TypeError(`${description} retrieved_at is not an ISO timestamp`);
  }
  if (!isBoundedString(value.excerpt, 300)) {
    throw new TypeError(`${description} excerpt is invalid`);
  }
  if (
    !Array.isArray(value.claims) ||
    value.claims.length === 0 ||
    value.claims.length > MAX_CLAIMS_PER_SOURCE ||
    !value.claims.every((claim) => isBoundedString(claim, 500))
  ) {
    throw new TypeError(`${description} claims are invalid`);
  }
  return value as unknown as EvidenceSource;
}

function parseEvidenceProbe(value: unknown, index: number): EvidenceProbe {
  const description = `review evidence probe ${index + 1}`;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["command", "result_digest", "summary"])
  ) {
    throw new TypeError(`${description} has unknown or missing fields`);
  }
  if (!isBoundedString(value.command, 500)) {
    throw new TypeError(`${description} command is invalid`);
  }
  if (!isDigest(value.result_digest)) {
    throw new TypeError(`${description} result_digest is invalid`);
  }
  if (!isBoundedString(value.summary, 500)) {
    throw new TypeError(`${description} summary is invalid`);
  }
  return value as unknown as EvidenceProbe;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys) === JSON.stringify([...expected].sort());
}
