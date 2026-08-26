import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const DEFAULT_TARGET_REPO = "letta-ai/letta-code";
export const BUILTIN_SKILLS_DIR = "src/skills/builtin";

export interface PriorSkillAudit {
  candidate_id: string;
  audited_sha: string;
  skill_digest: string;
  audited_at: string;
}

export interface RepositoryChanges {
  previous_sha: string | null;
  changed_files: string[];
  commits: string[];
  history_available: boolean;
  truncated: boolean;
}

export interface BuiltinSkillWatchAnalysis {
  schema_version: 1;
  candidate_id: string;
  skill: string;
  skill_path: string;
  skill_files: string[];
  skill_digest: string;
  current_sha: string;
  audit_at: string;
  previous_audit: PriorSkillAudit | null;
  repository_changes: RepositoryChanges;
  skill_inventory: string[];
  workflow_run_url: string;
}

export interface BuildAnalysisOptions {
  skill: string;
  currentSha: string;
  auditAt: string;
  previousAudit?: PriorSkillAudit | null;
}

export function listBuiltinSkillsAtCommit(commit: string): string[] {
  const files = runGit([
    "ls-tree",
    "-r",
    "--name-only",
    commit,
    "--",
    BUILTIN_SKILLS_DIR,
  ]);
  return files
    .split("\n")
    .map(
      (path) => path.match(/^src\/skills\/builtin\/([^/]+)\/SKILL\.md$/)?.[1],
    )
    .filter((skill): skill is string => skill !== undefined)
    .sort();
}

export function collectSkillFilesAtCommit(
  commit: string,
  skill: string,
): string[] {
  assertSkillName(skill);
  const prefix = `${BUILTIN_SKILLS_DIR}/${skill}`;
  return runGit(["ls-tree", "-r", "--name-only", commit, "--", prefix])
    .split("\n")
    .filter(Boolean)
    .sort();
}

export function buildAnalysis(
  options: BuildAnalysisOptions,
): BuiltinSkillWatchAnalysis {
  const currentSha = resolveCommit(options.currentSha);
  assertAuditAt(options.auditAt);
  const inventory = listBuiltinSkillsAtCommit(currentSha);
  if (!inventory.includes(options.skill)) {
    throw new Error(
      `Bundled skill ${options.skill} does not exist at ${currentSha}`,
    );
  }

  const skillFiles = collectSkillFilesAtCommit(currentSha, options.skill);
  const skillDigest = digestFiles(currentSha, skillFiles);
  const runUrl = workflowRunUrl();
  const candidateHash = createHash("sha256")
    .update(options.skill)
    .update("\0")
    .update(currentSha)
    .update("\0")
    .update(skillDigest)
    .update("\0")
    .update(options.auditAt)
    .digest("hex")
    .slice(0, 16);
  const candidateId = `${options.skill}@${currentSha.slice(0, 12)}-${candidateHash}`;

  return {
    schema_version: 1,
    candidate_id: candidateId,
    skill: options.skill,
    skill_path: `${BUILTIN_SKILLS_DIR}/${options.skill}`,
    skill_files: skillFiles,
    skill_digest: skillDigest,
    current_sha: currentSha,
    audit_at: options.auditAt,
    previous_audit: options.previousAudit ?? null,
    repository_changes: collectRepositoryChanges(
      options.previousAudit?.audited_sha ?? null,
      currentSha,
    ),
    skill_inventory: inventory,
    workflow_run_url: runUrl,
  };
}

function digestFiles(commit: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path);
    hash.update("\0");
    hash.update(runGitBuffer(["show", `${commit}:${path}`]));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectRepositoryChanges(
  previousSha: string | null,
  currentSha: string,
): RepositoryChanges {
  if (!previousSha || previousSha === currentSha) {
    return {
      previous_sha: previousSha,
      changed_files: [],
      commits: [],
      history_available: previousSha === currentSha,
      truncated: false,
    };
  }

  const ancestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", previousSha, currentSha],
    { encoding: "utf8" },
  );
  if (ancestor.status !== 0) {
    return {
      previous_sha: previousSha,
      changed_files: [],
      commits: [],
      history_available: false,
      truncated: false,
    };
  }

  const allFiles = runGit([
    "diff",
    "--name-only",
    `${previousSha}..${currentSha}`,
  ])
    .split("\n")
    .filter(Boolean);
  const allCommits = runGit([
    "log",
    "--format=%H %s",
    `${previousSha}..${currentSha}`,
  ])
    .split("\n")
    .filter(Boolean);
  return {
    previous_sha: previousSha,
    changed_files: allFiles.slice(0, 500),
    commits: allCommits.slice(0, 100),
    history_available: true,
    truncated: allFiles.length > 500 || allCommits.length > 100,
  };
}

function runGit(args: string[], trim = true): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function runGitBuffer(args: string[]): Buffer {
  const result = spawnSync("git", args, {
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

function resolveCommit(commit: string): string {
  return runGit(["rev-parse", `${commit}^{commit}`]);
}

function assertSkillName(skill: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) {
    throw new Error(`Invalid bundled skill name: ${skill}`);
  }
}

function assertAuditAt(auditAt: string): void {
  const parsed = new Date(auditAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== auditAt) {
    throw new Error(`Invalid audit timestamp: ${auditAt}`);
  }
}

function workflowRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return server && repository && runId
    ? `${server}/${repository}/actions/runs/${runId}`
    : "";
}
