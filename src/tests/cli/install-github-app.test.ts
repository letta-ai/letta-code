import { describe, expect, test } from "bun:test";
import {
  buildInstallPrBody,
  generateLettaWorkflowYaml,
  getDefaultWorkflowPath,
  parseGitHubRepoFromRemote,
  parseScopesFromGhAuthStatus,
  validateRepoSlug,
} from "../../cli/commands/install-github-app";

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
