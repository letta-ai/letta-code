import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface ReviewFailureReceipt {
  schema_version: 1;
  candidate_id: string;
  skill: string;
  kind:
    | "action_failed"
    | "execution_file_missing"
    | "result_marker_missing"
    | "result_decode_failed";
  message: string;
  conversation_id: string | null;
}

export interface ReviewArtifacts {
  results: Map<string, string>;
  failures: Map<string, ReviewFailureReceipt>;
}

export function discoverReviewArtifacts(root: string): ReviewArtifacts {
  const artifacts: ReviewArtifacts = {
    results: new Map(),
    failures: new Map(),
  };
  for (const path of walkFiles(root)) {
    const name = basename(path);
    if (name === "result.json") {
      const candidateId = readCandidateId(path, "review result");
      addUnique(artifacts.results, candidateId, path, "review result");
    } else if (name === "failure.json") {
      const receipt = parseFailureReceipt(
        JSON.parse(readFileSync(path, "utf8")) as unknown,
      );
      addUnique(
        artifacts.failures,
        receipt.candidate_id,
        receipt,
        "failure receipt",
      );
    }
  }
  return artifacts;
}

export function formatFailureReceipt(receipt: ReviewFailureReceipt): string {
  const conversation = receipt.conversation_id
    ? ` (conversation ${receipt.conversation_id})`
    : "";
  return `${receipt.kind}: ${receipt.message}${conversation}`;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return files;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function readCandidateId(path: string, description: string): string {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(value) || !isCandidateId(value.candidate_id)) {
    throw new Error(`${description} ${path} has no valid candidate_id`);
  }
  return value.candidate_id;
}

function parseFailureReceipt(value: unknown): ReviewFailureReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema_version",
      "candidate_id",
      "skill",
      "kind",
      "message",
      "conversation_id",
    ]) ||
    value.schema_version !== 1 ||
    !isCandidateId(value.candidate_id) ||
    !isSkillName(value.skill) ||
    !isFailureKind(value.kind) ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 500 ||
    (value.conversation_id !== null && !isConversationId(value.conversation_id))
  ) {
    throw new Error("Review failure receipt is invalid");
  }
  return value as unknown as ReviewFailureReceipt;
}

function addUnique<T>(
  values: Map<string, T>,
  candidateId: string,
  value: T,
  description: string,
): void {
  if (values.has(candidateId)) {
    throw new Error(`Found duplicate ${description} for ${candidateId}`);
  }
  values.set(candidateId, value);
}

function isFailureKind(value: unknown): value is ReviewFailureReceipt["kind"] {
  return (
    value === "action_failed" ||
    value === "execution_file_missing" ||
    value === "result_marker_missing" ||
    value === "result_decode_failed"
  );
}

function isCandidateId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*@[a-f0-9]{12}-[a-f0-9]{16}$/.test(value)
  );
}

function isSkillName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^conv-[a-zA-Z0-9-]+$/.test(value);
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}
