import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadSecrets } from "@/utils/secrets-store";
import { getVersion } from "@/version";

const execFile = promisify(execFileCb);

const HF_REPO_ID = "letta-ai/reflection-arena";
const HF_REPO_URL = `https://huggingface.co/datasets/${HF_REPO_ID}`;
const GIT_TIMEOUT_MS = 60_000;
const HF_CACHE_ROOT = join(
  homedir(),
  ".letta",
  "reflection-arena",
  "hf-upload",
);
const HF_REPO_DIR = join(HF_CACHE_ROOT, "repo");

export interface ReflectionArenaHfChoiceRow {
  run_id: string;
  choice: "win_loss" | "tie";
  winner: string | null;
  loser: string | null;
  winner_agent_id: string | null;
  loser_agent_id: string | null;
  parent_agent_id: string;
  timestamp: string;
  feedbackstr: string | null;
  parent_convo_id: string;
  lc_version: string;
  memory_base_commit: string | null;
  memory_candidate_commit: string | null;
}

export type ReflectionArenaHfUploadResult =
  | { uploaded: true; repoId: string; path: string }
  | { uploaded: false; reason: "missing_token" | "failed"; error?: string };

function buildGitEnv(token: string, askpassPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    HF_TOKEN_FOR_GIT: token,
    GIT_AUTHOR_NAME: "Letta Code",
    GIT_AUTHOR_EMAIL: "noreply@letta.com",
    GIT_COMMITTER_NAME: "Letta Code",
    GIT_COMMITTER_EMAIL: "noreply@letta.com",
  };
}

function sanitizeUploadError(value: unknown): string {
  const error = value as Error & { stderr?: string; stdout?: string };
  return [error.message, error.stderr, error.stdout]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n")
    .replace(/hf_[A-Za-z0-9_-]+/g, "hf_***")
    .trim();
}

function formatTokenStatus(token: string): string {
  return `token present; prefix hf_: ${token.startsWith("hf_") ? "yes" : "no"}; length: ${token.length}`;
}

async function runGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await execFile("git", args, {
      cwd,
      env,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 5,
    });
  } catch (error) {
    throw new Error(sanitizeUploadError(error));
  }
}

const HF_DATASET_PATH = "data/choices.jsonl";

async function writeGitAskpass(repoRoot: string): Promise<string> {
  const askpassPath = join(repoRoot, "hf-askpass.sh");
  await writeFile(
    askpassPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  *Username*) printf '%s\\n' 'hf_user' ;;",
      "  *) printf '%s\\n' \"$HF_TOKEN_FOR_GIT\" ;;",
      "esac",
      "",
    ].join("\n"),
    { encoding: "utf-8", mode: 0o700 },
  );
  await chmod(askpassPath, 0o700);
  return askpassPath;
}

async function prepareHfRepo(env: NodeJS.ProcessEnv): Promise<string> {
  await mkdir(HF_CACHE_ROOT, { recursive: true });
  if (!existsSync(join(HF_REPO_DIR, ".git"))) {
    await runGit(
      HF_CACHE_ROOT,
      ["clone", "--depth", "1", HF_REPO_URL, HF_REPO_DIR],
      env,
    );
    return HF_REPO_DIR;
  }

  await runGit(HF_REPO_DIR, ["fetch", "origin", "main"], env);
  await runGit(HF_REPO_DIR, ["reset", "--hard", "origin/main"], env);
  return HF_REPO_DIR;
}

export function buildReflectionArenaHfChoiceRow(input: {
  runId: string;
  choice: "win_loss" | "tie";
  winner: string | null;
  loser: string | null;
  winnerAgentId: string | null;
  loserAgentId: string | null;
  parentAgentId: string;
  timestamp: string;
  feedback?: string;
  parentConversationId: string;
  memoryBaseCommit: string | null;
  memoryCandidateCommit: string | null;
}): ReflectionArenaHfChoiceRow {
  return {
    run_id: input.runId,
    choice: input.choice,
    winner: input.winner,
    loser: input.loser,
    winner_agent_id: input.winnerAgentId,
    loser_agent_id: input.loserAgentId,
    parent_agent_id: input.parentAgentId,
    timestamp: input.timestamp,
    feedbackstr: input.feedback?.trim() || null,
    parent_convo_id: input.parentConversationId,
    lc_version: getVersion(),
    memory_base_commit: input.memoryBaseCommit,
    memory_candidate_commit: input.memoryCandidateCommit,
  };
}

export async function maybeUploadReflectionArenaChoiceToHf(
  row: ReflectionArenaHfChoiceRow,
): Promise<ReflectionArenaHfUploadResult> {
  const token =
    process.env.HF_TOKEN?.trim() ||
    loadSecrets(row.parent_agent_id).HF_TOKEN?.trim();
  if (!token) {
    return { uploaded: false, reason: "missing_token" };
  }

  await mkdir(HF_CACHE_ROOT, { recursive: true });
  const askpassPath = await writeGitAskpass(HF_CACHE_ROOT);
  const env = buildGitEnv(token, askpassPath);
  try {
    const repoDir = await prepareHfRepo(env);
    await mkdir(join(repoDir, "data"), { recursive: true });
    await appendFile(
      join(repoDir, HF_DATASET_PATH),
      `${JSON.stringify(row)}\n`,
      {
        encoding: "utf-8",
      },
    );
    await runGit(repoDir, ["add", HF_DATASET_PATH], env);
    await runGit(
      repoDir,
      ["commit", "-m", `Add reflection arena choice ${row.run_id}`],
      env,
    );
    try {
      await runGit(repoDir, ["push", "origin", "main"], env);
    } catch {
      await runGit(repoDir, ["pull", "--rebase", "origin", "main"], env);
      await runGit(repoDir, ["push", "origin", "main"], env);
    }
    return { uploaded: true, repoId: HF_REPO_ID, path: HF_DATASET_PATH };
  } catch (error) {
    const details = sanitizeUploadError(error);
    return {
      uploaded: false,
      reason: "failed",
      error: `${formatTokenStatus(token)}${details ? `; error: ${details}` : ""}`,
    };
  }
}
