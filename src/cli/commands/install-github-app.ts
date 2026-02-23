import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_WORKFLOW_PATH = ".github/workflows/letta.yml";
const ALTERNATE_WORKFLOW_PATH = ".github/workflows/letta-code.yml";

function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  input?: string,
): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      ...(input ? { input } : {}),
    }).trim();
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    const message = stderr || err.message || `Failed to run ${command}`;
    throw new Error(message);
  }
}

export interface GhPreflightResult {
  ok: boolean;
  currentRepo: string | null;
  scopes: string[];
  hasRepoScope: boolean;
  hasWorkflowScope: boolean;
  remediation?: string;
  details: string;
}

export interface RepoSetupState {
  workflowExists: boolean;
  secretExists: boolean;
}

export interface InstallGithubAppOptions {
  repo: string;
  workflowPath: string;
  reuseExistingSecret: boolean;
  apiKey: string | null;
  onProgress?: (status: string) => void;
}

export interface InstallGithubAppResult {
  repo: string;
  workflowPath: string;
  branchName: string | null;
  pullRequestUrl: string | null;
  committed: boolean;
  secretAction: "reused" | "set";
}

function progress(fn: InstallGithubAppOptions["onProgress"], status: string) {
  if (fn) {
    fn(status);
  }
}

export function validateRepoSlug(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim());
}

export function parseGitHubRepoFromRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();

  const httpsMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = trimmed.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
  );
  if (sshMatch?.[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  const sshUrlMatch = trimmed.match(
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (sshUrlMatch?.[1] && sshUrlMatch[2]) {
    return `${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }

  return null;
}

export function parseScopesFromGhAuthStatus(rawStatus: string): string[] {
  const lines = rawStatus.split(/\r?\n/);
  const tokenScopeLine = lines.find((line) =>
    line.toLowerCase().includes("token scopes:"),
  );
  if (!tokenScopeLine) {
    return [];
  }

  const [, scopesRaw = ""] = tokenScopeLine.split(/token scopes:/i);
  return scopesRaw
    .split(",")
    .map((scope) => scope.replace(/['"`]/g, "").trim())
    .filter((scope) => scope.length > 0);
}

function getCurrentRepoSlug(cwd: string): string | null {
  try {
    runCommand("git", ["rev-parse", "--git-dir"], cwd);
  } catch {
    return null;
  }

  try {
    const remote = runCommand("git", ["remote", "get-url", "origin"], cwd);
    return parseGitHubRepoFromRemote(remote);
  } catch {
    return null;
  }
}

export function runGhPreflight(cwd: string): GhPreflightResult {
  try {
    runCommand("gh", ["--version"]);
  } catch {
    return {
      ok: false,
      currentRepo: getCurrentRepoSlug(cwd),
      scopes: [],
      hasRepoScope: false,
      hasWorkflowScope: false,
      remediation: "Install GitHub CLI: https://cli.github.com/",
      details: "GitHub CLI (gh) is not installed or not available in PATH.",
    };
  }

  let rawStatus = "";
  try {
    rawStatus = runCommand("gh", ["auth", "status", "-h", "github.com"]);
  } catch {
    return {
      ok: false,
      currentRepo: getCurrentRepoSlug(cwd),
      scopes: [],
      hasRepoScope: false,
      hasWorkflowScope: false,
      remediation: "Run: gh auth login",
      details: "GitHub CLI is not authenticated for github.com.",
    };
  }

  const scopes = parseScopesFromGhAuthStatus(rawStatus);
  const hasRepoScope = scopes.length === 0 ? true : scopes.includes("repo");
  const hasWorkflowScope =
    scopes.length === 0 ? true : scopes.includes("workflow");

  if (!hasRepoScope || !hasWorkflowScope) {
    return {
      ok: false,
      currentRepo: getCurrentRepoSlug(cwd),
      scopes,
      hasRepoScope,
      hasWorkflowScope,
      remediation: "Run: gh auth refresh -h github.com -s repo,workflow",
      details:
        "GitHub CLI authentication is missing required scopes: repo and workflow.",
    };
  }

  return {
    ok: true,
    currentRepo: getCurrentRepoSlug(cwd),
    scopes,
    hasRepoScope,
    hasWorkflowScope,
    details: "GitHub CLI is ready.",
  };
}

export function generateLettaWorkflowYaml(): string {
  return [
    "name: Letta Code",
    "on:",
    "  issues:",
    "    types: [opened, labeled]",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request:",
    "    types: [opened, labeled]",
    "  pull_request_review_comment:",
    "    types: [created]",
    "",
    "jobs:",
    "  letta:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: write",
    "      issues: write",
    "      pull-requests: write",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: letta-ai/letta-code-action@v0",
    "        with:",
    "          letta_api_key: $" + "{{ secrets.LETTA_API_KEY }}",
    "          github_token: $" + "{{ secrets.GITHUB_TOKEN }}",
  ].join("\n");
}

export function buildInstallPrBody(workflowPath: string): string {
  return [
    "## 🤖 Install Letta Code GitHub Action",
    "",
    "This PR adds a GitHub Actions workflow that enables Letta Code in this repository.",
    "",
    "**What’s changing:**",
    `- Adds or updates \`${workflowPath}\``,
    "- Enables mention-based assistance via `@letta-code` in issues and PRs",
    "- Configures Letta Code action invocation in GitHub Actions",
    "",
    "**Security & Privacy:**",
    "- `LETTA_API_KEY` is stored as a GitHub Actions secret",
    "- All runs are recorded in GitHub Actions history",
    "",
    "After merge, mention `@letta-code` in an issue or PR to test the integration.",
  ].join("\n");
}

function checkRemoteFileExists(repo: string, path: string): boolean {
  try {
    runCommand("gh", ["api", `repos/${repo}/contents/${path}`]);
    return true;
  } catch {
    return false;
  }
}

export function getDefaultWorkflowPath(workflowExists: boolean): string {
  return workflowExists ? ALTERNATE_WORKFLOW_PATH : DEFAULT_WORKFLOW_PATH;
}

export function getRepoSetupState(repo: string): RepoSetupState {
  const workflowExists = checkRemoteFileExists(repo, DEFAULT_WORKFLOW_PATH);
  const secretExists = hasRepositorySecret(repo, "LETTA_API_KEY");
  return { workflowExists, secretExists };
}

export function hasRepositorySecret(repo: string, secretName: string): boolean {
  const output = runCommand("gh", ["secret", "list", "--repo", repo]);
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  return lines.some((line) => line.split(/\s+/)[0] === secretName);
}

export function setRepositorySecret(
  repo: string,
  secretName: string,
  value: string,
): void {
  runCommand(
    "gh",
    ["secret", "set", secretName, "--repo", repo],
    undefined,
    value,
  );
}

function cloneRepoToTemp(repo: string): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "letta-install-github-app-"));
  const repoDir = join(tempDir, "repo");
  runCommand("gh", ["repo", "clone", repo, repoDir]);
  return { tempDir, repoDir };
}

function createBranchName(): string {
  return `letta/install-github-app-${Date.now().toString(36)}`;
}

function runGit(args: string[], cwd: string): string {
  return runCommand("git", args, cwd);
}

function writeWorkflow(
  repoDir: string,
  workflowPath: string,
  content: string,
): boolean {
  const absolutePath = join(repoDir, workflowPath);
  if (!existsSync(dirname(absolutePath))) {
    mkdirSync(dirname(absolutePath), { recursive: true });
  }

  const next = `${content.trimEnd()}\n`;
  if (existsSync(absolutePath)) {
    const previous = readFileSync(absolutePath, "utf8");
    if (previous === next) {
      return false;
    }
  }

  writeFileSync(absolutePath, next, "utf8");
  return true;
}

function getDefaultBaseBranch(repoDir: string): string {
  try {
    const headRef = runGit(
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      repoDir,
    );
    return headRef.replace("refs/remotes/origin/", "").trim() || "main";
  } catch {
    return "main";
  }
}

function createPullRequest(
  repo: string,
  branchName: string,
  workflowPath: string,
  repoDir: string,
): string {
  const title = "chore: add Letta Code GitHub Action workflow";
  const body = buildInstallPrBody(workflowPath);
  const base = getDefaultBaseBranch(repoDir);

  return runCommand("gh", [
    "pr",
    "create",
    "--repo",
    repo,
    "--head",
    branchName,
    "--base",
    base,
    "--title",
    title,
    "--body",
    body,
  ]);
}

export async function installGithubApp(
  options: InstallGithubAppOptions,
): Promise<InstallGithubAppResult> {
  const { repo, workflowPath, reuseExistingSecret, apiKey, onProgress } =
    options;

  if (!validateRepoSlug(repo)) {
    throw new Error("Repository must be in owner/repo format.");
  }

  if (!reuseExistingSecret && !apiKey) {
    throw new Error(
      "LETTA_API_KEY is required when not reusing an existing secret.",
    );
  }

  const secretAction: "reused" | "set" = reuseExistingSecret ? "reused" : "set";
  if (!reuseExistingSecret && apiKey) {
    progress(onProgress, "Setting LETTA_API_KEY secret...");
    setRepositorySecret(repo, "LETTA_API_KEY", apiKey);
  }

  progress(onProgress, "Cloning repository...");
  const { tempDir, repoDir } = cloneRepoToTemp(repo);

  try {
    const workflowContent = generateLettaWorkflowYaml();

    progress(onProgress, "Creating installation branch...");
    const branchName = createBranchName();
    runGit(["checkout", "-b", branchName], repoDir);

    progress(onProgress, "Writing workflow file...");
    const changed = writeWorkflow(repoDir, workflowPath, workflowContent);

    if (!changed) {
      progress(onProgress, "Workflow already up to date.");
      return {
        repo,
        workflowPath,
        branchName: null,
        pullRequestUrl: null,
        committed: false,
        secretAction,
      };
    }

    progress(onProgress, "Committing workflow changes...");
    runGit(["add", workflowPath], repoDir);
    runGit(
      ["commit", "-m", "chore: add Letta Code GitHub Action workflow"],
      repoDir,
    );

    progress(onProgress, "Pushing branch...");
    runGit(["push", "-u", "origin", branchName], repoDir);

    progress(onProgress, "Opening pull request...");
    const pullRequestUrl = createPullRequest(
      repo,
      branchName,
      workflowPath,
      repoDir,
    );

    return {
      repo,
      workflowPath,
      branchName,
      pullRequestUrl,
      committed: true,
      secretAction,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
