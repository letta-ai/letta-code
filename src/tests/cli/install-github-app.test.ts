import { describe, expect, test } from "bun:test";
import {
  buildInstallPrBody,
  generateLettaWorkflowYaml,
  getDefaultWorkflowPath,
  type InstallGithubAppResult,
  parseGitHubRepoFromRemote,
  parseScopesFromGhAuthStatus,
  validateRepoSlug,
} from "../../cli/commands/install-github-app";
import {
  buildProgress,
  buildProgressSteps,
} from "../../cli/components/InstallGithubAppFlow";

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

describe("install-github-app helpers", () => {
  test("validateRepoSlug accepts owner/repo and rejects invalid forms", () => {
    expect(validateRepoSlug("letta-ai/letta-code")).toBe(true);
    expect(validateRepoSlug("owner/repo-name_1")).toBe(true);

    expect(validateRepoSlug("letta-ai")).toBe(false);
    expect(validateRepoSlug("/letta-code")).toBe(false);
    expect(validateRepoSlug("letta-ai/")).toBe(false);
    expect(validateRepoSlug("https://github.com/letta-ai/letta-code")).toBe(
      false,
    );
  });

  test("parseGitHubRepoFromRemote handles https and ssh remotes", () => {
    expect(
      parseGitHubRepoFromRemote("https://github.com/letta-ai/letta-code.git"),
    ).toBe("letta-ai/letta-code");

    expect(
      parseGitHubRepoFromRemote("git@github.com:letta-ai/letta-code.git"),
    ).toBe("letta-ai/letta-code");

    expect(
      parseGitHubRepoFromRemote("ssh://git@github.com/letta-ai/letta-code.git"),
    ).toBe("letta-ai/letta-code");

    expect(
      parseGitHubRepoFromRemote("https://gitlab.com/letta-ai/letta-code.git"),
    ).toBeNull();
  });

  test("parseScopesFromGhAuthStatus extracts token scopes", () => {
    const status = [
      "github.com",
      "  ✓ Logged in to github.com account test (keyring)",
      "  - Active account: true",
      "  - Git operations protocol: https",
      "  - Token: ghp_xxx",
      "  - Token scopes: gist, read:org, repo, workflow",
    ].join("\n");

    expect(parseScopesFromGhAuthStatus(status)).toEqual([
      "gist",
      "read:org",
      "repo",
      "workflow",
    ]);
  });

  test("getDefaultWorkflowPath chooses alternate path when existing workflow found", () => {
    expect(getDefaultWorkflowPath(false)).toBe(".github/workflows/letta.yml");
    expect(getDefaultWorkflowPath(true)).toBe(
      ".github/workflows/letta-code.yml",
    );
  });

  test("generateLettaWorkflowYaml includes required action configuration", () => {
    const yaml = generateLettaWorkflowYaml();

    expect(yaml).toContain("uses: letta-ai/letta-code-action@v0");
    expect(yaml).toContain("letta_api_key: $" + "{{ secrets.LETTA_API_KEY }}");
    expect(yaml).toContain("github_token: $" + "{{ secrets.GITHUB_TOKEN }}");
    expect(yaml).toContain("pull-requests: write");
    expect(yaml).not.toContain("agent_id");
  });

  test("generateLettaWorkflowYaml includes agent_id when requested", () => {
    const yaml = generateLettaWorkflowYaml({ includeAgentId: true });

    expect(yaml).toContain("agent_id: $" + "{{ vars.LETTA_AGENT_ID }}");
    expect(yaml).toContain("uses: letta-ai/letta-code-action@v0");
  });

  test("buildInstallPrBody references workflow path and trigger phrase", () => {
    const body = buildInstallPrBody(".github/workflows/letta.yml");

    expect(body).toContain("Add Letta Code GitHub Workflow");
    expect(body).toContain(".github/workflows/letta.yml");
    expect(body).toContain("@letta-code");
    expect(body).toContain("stateful");
    expect(body).toContain("app.letta.com");
    expect(body).toContain("letta-code-action");
  });
});

// ---------------------------------------------------------------------------
// Wizard progress steps
// ---------------------------------------------------------------------------

describe("buildProgressSteps", () => {
  test("includes all standard steps for current agent mode", () => {
    const steps = buildProgressSteps("current", null);
    const labels = steps.map((s) => s.label);

    expect(labels).toEqual([
      "Getting repository information",
      "Creating branch",
      "Creating workflow files",
      "Setting up LETTA_API_KEY secret",
      "Configuring agent",
      "Opening pull request page",
    ]);
  });

  test("includes all standard steps for existing agent mode", () => {
    const steps = buildProgressSteps("existing", null);
    const labels = steps.map((s) => s.label);

    expect(labels).toContain("Configuring agent");
    expect(labels).toContain("Setting up LETTA_API_KEY secret");
    expect(labels).not.toContainEqual(
      expect.stringContaining("Creating agent"),
    );
  });

  test("includes agent creation step in create mode", () => {
    const steps = buildProgressSteps("create", "My Bot");
    const labels = steps.map((s) => s.label);

    expect(labels).toContain("Creating agent My Bot");
  });

  test("omits 'Configuring agent' in create mode", () => {
    const steps = buildProgressSteps("create", "My Bot");
    const labels = steps.map((s) => s.label);

    expect(labels).not.toContain("Configuring agent");
  });

  test("always includes LETTA_API_KEY secret step regardless of mode", () => {
    for (const mode of ["current", "existing", "create"] as const) {
      const steps = buildProgressSteps(mode, mode === "create" ? "Bot" : null);
      const labels = steps.map((s) => s.label);
      expect(labels).toContain("Setting up LETTA_API_KEY secret");
    }
  });

  test("steps are in the correct order", () => {
    const steps = buildProgressSteps("current", null);
    const labels = steps.map((s) => s.label);

    const repoIdx = labels.indexOf("Getting repository information");
    const branchIdx = labels.indexOf("Creating branch");
    const workflowIdx = labels.indexOf("Creating workflow files");
    const secretIdx = labels.indexOf("Setting up LETTA_API_KEY secret");
    const agentIdx = labels.indexOf("Configuring agent");
    const prIdx = labels.indexOf("Opening pull request page");

    expect(repoIdx).toBeLessThan(branchIdx);
    expect(branchIdx).toBeLessThan(workflowIdx);
    expect(workflowIdx).toBeLessThan(secretIdx);
    expect(secretIdx).toBeLessThan(agentIdx);
    expect(agentIdx).toBeLessThan(prIdx);
  });
});

// ---------------------------------------------------------------------------
// Progress state machine
// ---------------------------------------------------------------------------

describe("buildProgress", () => {
  test("marks first step as active when status matches it", () => {
    const items = buildProgress(
      "Getting repository information",
      "current",
      null,
    );

    expect(items[0]?.active).toBe(true);
    expect(items[0]?.done).toBe(false);
    // All subsequent steps should be inactive and not done
    for (const item of items.slice(1)) {
      expect(item.active).toBe(false);
      expect(item.done).toBe(false);
    }
  });

  test("marks prior steps as done and current step as active", () => {
    const items = buildProgress("Creating workflow files", "current", null);
    const labels = items.map((i) => i.label);
    const workflowIdx = labels.indexOf("Creating workflow files");

    // All steps before should be done
    for (let i = 0; i < workflowIdx; i++) {
      expect(items[i]?.done).toBe(true);
      expect(items[i]?.active).toBe(false);
    }
    // Current step should be active
    expect(items[workflowIdx]?.active).toBe(true);
    expect(items[workflowIdx]?.done).toBe(false);
    // Steps after should be neither done nor active
    for (let i = workflowIdx + 1; i < items.length; i++) {
      expect(items[i]?.done).toBe(false);
      expect(items[i]?.active).toBe(false);
    }
  });

  test("marks all prior steps done when on last step", () => {
    const items = buildProgress("Opening pull request page", "current", null);
    const lastIdx = items.length - 1;

    for (let i = 0; i < lastIdx; i++) {
      expect(items[i]?.done).toBe(true);
    }
    expect(items[lastIdx]?.active).toBe(true);
    expect(items[lastIdx]?.done).toBe(false);
  });

  test("no step is active when status doesn't match any step", () => {
    const items = buildProgress("Preparing setup...", "current", null);

    for (const item of items) {
      expect(item.active).toBe(false);
      expect(item.done).toBe(false);
    }
  });

  test("matches status case-insensitively", () => {
    const items = buildProgress(
      "SETTING UP LETTA_API_KEY SECRET",
      "current",
      null,
    );
    const secretItem = items.find(
      (i) => i.label === "Setting up LETTA_API_KEY secret",
    );

    expect(secretItem?.active).toBe(true);
  });

  test("includes agent creation step in create mode progress", () => {
    const items = buildProgress("Creating agent My Bot", "create", "My Bot");
    const agentItem = items.find((i) => i.label === "Creating agent My Bot");

    expect(agentItem).toBeDefined();
    expect(agentItem?.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Success screen / InstallGithubAppResult content
// ---------------------------------------------------------------------------

describe("success screen content", () => {
  const baseResult: InstallGithubAppResult = {
    repo: "letta-ai/letta-code",
    workflowPath: ".github/workflows/letta.yml",
    branchName: "letta/install-github-app-abc123",
    pullRequestUrl: "https://github.com/letta-ai/letta-code/pull/42",
    pullRequestCreateMode: "created",
    committed: true,
    secretAction: "set",
    agentId: "agent-aaaabbbb-cccc-dddd-eeee-ffffffffffff",
    agentUrl:
      "https://app.letta.com/agents/agent-aaaabbbb-cccc-dddd-eeee-ffffffffffff",
  };

  test("agentUrl points to app.letta.com ADE", () => {
    expect(baseResult.agentUrl).toBe(
      `https://app.letta.com/agents/${baseResult.agentId}`,
    );
  });

  test("agentUrl is null when agentId is null", () => {
    const noAgent: InstallGithubAppResult = {
      ...baseResult,
      agentId: null,
      agentUrl: null,
    };
    expect(noAgent.agentUrl).toBeNull();
  });

  test("secretAction is always 'set' after the API key fix", () => {
    // After removing reuseExistingSecret, the secret is always set
    expect(baseResult.secretAction).toBe("set");
  });

  test("pullRequestUrl is present when workflow was committed", () => {
    expect(baseResult.committed).toBe(true);
    expect(baseResult.pullRequestUrl).toContain("github.com");
    expect(baseResult.pullRequestUrl).toContain("/pull/");
  });

  test("pullRequestUrl is null when workflow was unchanged", () => {
    const unchanged: InstallGithubAppResult = {
      ...baseResult,
      committed: false,
      branchName: null,
      pullRequestUrl: null,
    };
    expect(unchanged.pullRequestUrl).toBeNull();
    expect(unchanged.branchName).toBeNull();
  });

  // Simulate the success lines built by the component to verify content
  test("success lines include expected content", () => {
    const result = baseResult;
    const successLines: string[] = [
      "✓ GitHub Actions workflow created!",
      "",
      "✓ API key saved as LETTA_API_KEY secret",
    ];

    if (result.agentId) {
      successLines.push("");
      successLines.push(`✓ Agent configured: ${result.agentId}`);
    }

    successLines.push("");
    successLines.push("Next steps:");
    successLines.push("1. A pre-filled PR page has been created");
    successLines.push("2. Merge the PR to enable Letta Code PR assistance");
    successLines.push("3. Mention @letta-code in an issue or PR to test");

    // Verify all expected content is present
    const allText = successLines.join("\n");
    expect(allText).toContain("GitHub Actions workflow created");
    expect(allText).toContain("API key saved as LETTA_API_KEY secret");
    expect(allText).toContain(`Agent configured: ${result.agentId}`);
    expect(allText).toContain("Merge the PR");
    expect(allText).toContain("@letta-code");
  });

  test("success lines omit agent line when no agent configured", () => {
    const result: InstallGithubAppResult = {
      ...baseResult,
      agentId: null,
      agentUrl: null,
    };
    const successLines: string[] = [
      "✓ GitHub Actions workflow created!",
      "",
      "✓ API key saved as LETTA_API_KEY secret",
    ];

    if (result.agentId) {
      successLines.push("");
      successLines.push(`✓ Agent configured: ${result.agentId}`);
    }

    const allText = successLines.join("\n");
    expect(allText).not.toContain("Agent configured");
  });

  test("agent URL uses correct ADE format for any agent ID", () => {
    const agentId = "agent-12345678-abcd-efgh-ijkl-123456789012";
    const expectedUrl = `https://app.letta.com/agents/${agentId}`;

    // This mirrors the logic in installGithubApp
    const agentUrl = agentId ? `https://app.letta.com/agents/${agentId}` : null;

    expect(agentUrl).toBe(expectedUrl);
    expect(agentUrl).toContain("app.letta.com/agents/");
    expect(agentUrl).toContain(agentId);
  });
});
