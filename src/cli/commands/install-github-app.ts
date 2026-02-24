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

function ensureRepoAccess(repo: string): void {
  runCommand("gh", ["repo", "view", repo, "--json", "nameWithOwner"]);
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
}

export interface InstallGithubAppOptions {
  repo: string;
  workflowPath: string;
  apiKey: string | null;
  agentMode: "current" | "existing" | "create";
  agentId: string | null;
  agentName: string | null;
  onProgress?: (status: string) => void;
}

export interface InstallGithubAppResult {
  repo: string;
  workflowPath: string;
  branchName: string | null;
  pullRequestUrl: string | null;
  pullRequestCreateMode: "created" | "page-opened";
  committed: boolean;
  secretAction: "reused" | "set";
  agentId: string | null;
  agentUrl: string | null;
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

export function generateLettaWorkflowYaml(options?: {
  includeAgentId?: boolean;
}): string {
  const lines = [
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
  ];

  if (options?.includeAgentId) {
    lines.push("          agent_id: $" + "{{ vars.LETTA_AGENT_ID }}");
  }

  return lines.join("\n");
}

export function buildInstallPrBody(workflowPath: string): string {
  return [
    "## 👾 Add Letta Code GitHub Workflow",
    "",
    `This PR adds [\`${workflowPath}\`](${workflowPath}), a GitHub Actions workflow that enables [Letta Code](https://docs.letta.com/letta-code) integration in this repository.`,
    "",
    "### What is Letta Code?",
    "",
    "[Letta Code](https://docs.letta.com/letta-code) is a stateful AI coding agent that can help with:",
    "- Bug fixes and improvements",
    "- Documentation updates",
    "- Implementing new features",
    "- Code reviews and suggestions",
    "- Writing tests",
    "- And more!",
    "",
    "### How it works",
    "",
    "Once this PR is merged, you can interact with Letta Code by mentioning `@letta-code` in a pull request or issue comment.",
    "",
    "When triggered, Letta Code will analyze the comment and surrounding context and execute on the request in a GitHub Action. Because Letta agents are **stateful**, every interaction builds on the same persistent memory \u2014 the agent learns your codebase and preferences over time.",
    "",
    "### Conversations",
    "",
    "Each issue and PR gets its own **conversation** with the same underlying agent:",
    "- Commenting `@letta-code` on a new issue or PR starts a new conversation",
    "- Additional comments on the **same issue or PR** continue the existing conversation \u2014 the agent remembers the full thread",
    '- If the agent opens a PR from an issue (e.g. via "Fixes #N"), follow-up comments on the PR continue the **issue\'s conversation** automatically',
    "- Use `@letta-code [--new]` to force a fresh conversation while keeping the same agent",
    "",
    "You can also specify a particular agent: `@letta-code [--agent agent-xxx]`",
    "",
    "View agent runs and conversations at [app.letta.com](https://app.letta.com).",
    "",
    "### Important Notes",
    "",
    "- **This workflow won't take effect until this PR is merged**",
    "- **`@letta-code` mentions won't work until after the merge is complete**",
    "- The workflow runs automatically whenever Letta Code is mentioned in PR or issue comments",
    "- Letta Code gets access to the entire PR or issue context including files, diffs, and previous comments",
    "",
    "There's more information in the [Letta Code Action repo](https://github.com/letta-ai/letta-code-action).",
    "",
    "After merging this PR, try mentioning `@letta-code` in a comment on any PR to get started!",
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
  return { workflowExists };
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

export function setRepositoryVariable(
  repo: string,
  name: string,
  value: string,
): void {
  runCommand("gh", ["variable", "set", name, "--repo", repo, "--body", value]);
}

export async function createLettaAgent(
  apiKey: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await fetch("https://api.letta.com/v1/agents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create agent: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
}

function cloneRepoToTemp(repo: string): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "letta-install-github-app-"));
  const repoDir = join(tempDir, "repo");
  runCommand("gh", ["repo", "clone", repo, repoDir, "--", "--depth=1"]);
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
): { url: string; mode: "created" | "page-opened" } {
  const title = "Add Letta Code GitHub Workflow";
  const body = buildInstallPrBody(workflowPath);
  const base = getDefaultBaseBranch(repoDir);

  try {
    const url = runCommand("gh", [
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
      "--web",
    ]);
    return { url, mode: "page-opened" };
  } catch {
    const url = runCommand("gh", [
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
    return { url, mode: "created" };
  }
}

export async function installGithubApp(
  options: InstallGithubAppOptions,
): Promise<InstallGithubAppResult> {
  const {
    repo,
    workflowPath,
    apiKey,
    agentMode,
    agentId: providedAgentId,
    agentName,
    onProgress,
  } = options;

  if (!validateRepoSlug(repo)) {
    throw new Error("Repository must be in owner/repo format.");
  }

  if (!apiKey) {
    throw new Error("LETTA_API_KEY is required.");
  }
  let resolvedAgentId: string | null = providedAgentId;

  progress(onProgress, "Getting repository information");
  ensureRepoAccess(repo);

  // Create agent if needed
  if (agentMode === "create" && agentName) {
    progress(onProgress, `Creating agent ${agentName}`);
    const agent = await createLettaAgent(apiKey, agentName);
    resolvedAgentId = agent.id;
  }

  progress(onProgress, "Creating branch");
  const { tempDir, repoDir } = cloneRepoToTemp(repo);

  try {
    const workflowContent = generateLettaWorkflowYaml({
      includeAgentId: resolvedAgentId != null,
    });

    const branchName = createBranchName();
    runGit(["checkout", "-b", branchName], repoDir);

    progress(onProgress, "Creating workflow files");
    const changed = writeWorkflow(repoDir, workflowPath, workflowContent);

    // Always set the secret from the locally-available key
    progress(onProgress, "Setting up LETTA_API_KEY secret");
    setRepositorySecret(repo, "LETTA_API_KEY", apiKey);

    if (resolvedAgentId) {
      progress(onProgress, "Configuring agent");
      setRepositoryVariable(repo, "LETTA_AGENT_ID", resolvedAgentId);
    }

    if (!changed) {
      progress(onProgress, "Workflow already up to date.");
      return {
        repo,
        workflowPath,
        branchName: null,
        pullRequestUrl: null,
        pullRequestCreateMode: "created",
        committed: false,
        secretAction: "set",
        agentId: resolvedAgentId,
        agentUrl: resolvedAgentId
          ? `https://app.letta.com/agents/${resolvedAgentId}`
          : null,
      };
    }

    runGit(["add", workflowPath], repoDir);
    runGit(["commit", "-m", "Add Letta Code GitHub Workflow"], repoDir);

    progress(onProgress, "Opening pull request page");
    runGit(["push", "-u", "origin", branchName], repoDir);

    const pullRequest = createPullRequest(
      repo,
      branchName,
      workflowPath,
      repoDir,
    );

    return {
      repo,
      workflowPath,
      branchName,
      pullRequestUrl: pullRequest.url,
      pullRequestCreateMode: pullRequest.mode,
      committed: true,
      secretAction: "set",
      agentId: resolvedAgentId,
      agentUrl: resolvedAgentId
        ? `https://app.letta.com/agents/${resolvedAgentId}`
        : null,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
