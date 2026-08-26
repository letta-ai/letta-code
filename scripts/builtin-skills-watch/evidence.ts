import { createHash } from "node:crypto";

const MAX_SOURCES = 5;
const MAX_PROBES = 5;
const MAX_CLAIMS_PER_SOURCE = 5;
const MAX_SERIALIZED_BYTES = 650;

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
    value.sources.length > MAX_SOURCES ||
    !value.sources.every(isEvidenceSource)
  ) {
    throw new TypeError("review evidence sources are invalid");
  }
  if (
    !Array.isArray(value.probes) ||
    value.probes.length > MAX_PROBES ||
    !value.probes.every(isEvidenceProbe)
  ) {
    throw new TypeError("review evidence probes are invalid");
  }
  const evidence: ReviewEvidence = {
    schema_version: 1,
    candidate_id: value.candidate_id,
    skill: value.skill,
    sources: value.sources,
    probes: value.probes,
  };
  if (
    Buffer.byteLength(JSON.stringify(evidence), "utf8") > MAX_SERIALIZED_BYTES
  ) {
    throw new TypeError("review evidence exceeds 650 bytes");
  }
  return evidence;
}

export function digestReviewEvidence(evidence: ReviewEvidence): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

function isEvidenceSource(value: unknown): value is EvidenceSource {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "locator",
      "revision",
      "content_digest",
      "retrieved_at",
      "excerpt",
      "claims",
    ]) &&
    isBoundedString(value.locator, 500) &&
    (value.revision === null || isBoundedString(value.revision, 300)) &&
    (value.content_digest === null || isDigest(value.content_digest)) &&
    (value.revision !== null || value.content_digest !== null) &&
    isIsoTimestamp(value.retrieved_at) &&
    isBoundedString(value.excerpt, 300) &&
    Array.isArray(value.claims) &&
    value.claims.length > 0 &&
    value.claims.length <= MAX_CLAIMS_PER_SOURCE &&
    value.claims.every((claim) => isBoundedString(claim, 500))
  );
}

function isEvidenceProbe(value: unknown): value is EvidenceProbe {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["command", "result_digest", "summary"]) &&
    isBoundedString(value.command, 500) &&
    isDigest(value.result_digest) &&
    isBoundedString(value.summary, 500)
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
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
