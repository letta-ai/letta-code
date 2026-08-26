import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBuiltinSkillsAtCommit } from "./analysis.ts";

const AUDIT_AT = "2026-08-26T00:00:00.000Z";

describe("built-in skills watch preparation", () => {
  test("emits one candidate for every discovered bundled skill", () => {
    const directory = mkdtempSync(join(tmpdir(), "builtin-skills-watch-"));
    try {
      const manifest = runDryPreparation(directory);
      const inventory = listBuiltinSkillsAtCommit("HEAD");

      expect(manifest.inventory).toEqual(inventory);
      expect(manifest.candidates.map((candidate) => candidate.skill)).toEqual(
        inventory,
      );
      expect(manifest.candidates).toHaveLength(inventory.length);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("manual skill selection emits only that skill", () => {
    const directory = mkdtempSync(join(tmpdir(), "builtin-skills-watch-"));
    try {
      const manifest = runDryPreparation(directory, "creating-skills");
      expect(manifest.candidates.map((candidate) => candidate.skill)).toEqual([
        "creating-skills",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rebuilds the previous audit passed to a matrix job", () => {
    const directory = mkdtempSync(join(tmpdir(), "builtin-skills-watch-"));
    const previousAudit = {
      candidate_id: `creating-skills@${"a".repeat(12)}-${"b".repeat(16)}`,
      audited_sha: "a".repeat(40),
      skill_digest: "b".repeat(64),
      audited_at: "2026-08-25T00:00:00.000Z",
    };
    try {
      runDryPreparation(directory, "creating-skills", previousAudit);
      const analysis = JSON.parse(
        readFileSync(join(directory, "analyses/creating-skills.json"), "utf8"),
      ) as { previous_audit: unknown };
      expect(analysis.previous_audit).toEqual(previousAudit);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

interface Manifest {
  inventory: string[];
  candidates: Array<{ skill: string }>;
}

function runDryPreparation(
  directory: string,
  skill?: string,
  previousAudit?: object,
): Manifest {
  const analysisDir = join(directory, "analyses");
  const manifestFile = join(directory, "manifest.json");
  const command = [
    "bun",
    "scripts/builtin-skills-watch/agent-watch.ts",
    "--dry-run",
    "--current-sha",
    "HEAD",
    "--audit-at",
    AUDIT_AT,
    "--analysis-dir",
    analysisDir,
    "--manifest-file",
    manifestFile,
  ];
  if (skill) command.push("--skill", skill);
  if (previousAudit) {
    command.push(
      "--previous-audit-base64",
      Buffer.from(JSON.stringify(previousAudit)).toString("base64"),
    );
  }
  const result = Bun.spawnSync(command, {
    env: {
      ...process.env,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "letta-ai/letta-code",
      GITHUB_RUN_ID: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
}
