/**
 * Shared GitHub API utilities for skills import/export
 */

export interface GitHubEntry {
  type: "file" | "dir";
  name: string;
  path: string;
  download_url?: string;
}

/**
 * Fetch GitHub contents using gh CLI (authenticated) or direct API
 * Returns array of directory/file entries
 */
function validateGitHubParam(value: string, name: string): void {
  if (!value || typeof value !== "string") {
    throw new Error(`Invalid ${name}: must be a non-empty string`);
  }
  if (name === "path") {
    if (!/^[a-zA-Z0-9._~/-]+$/.test(value)) {
      throw new Error(`Invalid ${name}: contains disallowed characters`);
    }
  } else if (name === "owner" || name === "repo") {
    if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
      throw new Error(`Invalid ${name}: contains disallowed characters`);
    }
  } else if (name === "branch") {
    if (!/^[a-zA-Z0-9._~:/-]+$/.test(value)) {
      throw new Error(`Invalid ${name}: contains disallowed characters`);
    }
  }
}

export async function fetchGitHubContents(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<GitHubEntry[]> {
  validateGitHubParam(owner, "owner");
  validateGitHubParam(repo, "repo");
  validateGitHubParam(branch, "branch");
  if (path) {
    validateGitHubParam(path, "path");
  }

  const encodedPath = path ? encodeURIComponent(path).replace(/%2F/g, "/") : "";
  const apiPath = path
    ? `repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
    : `repos/${owner}/${repo}/contents?ref=${encodeURIComponent(branch)}`;

  // Try gh CLI (authenticated, 5000 req/hr)
  try {
    const { execFileSync } = await import("node:child_process");
    const result = execFileSync("gh", ["api", apiPath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return JSON.parse(result) as GitHubEntry[];
  } catch {
    // Fall back to unauthenticated API (60 req/hr)
  }

  // Try direct API
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "letta-code",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch from ${owner}/${repo}/${branch}/${path}: ${response.statusText}`,
    );
  }

  return (await response.json()) as GitHubEntry[];
}

/**
 * Extract directory names from GitHub entries
 */
export function parseDirNames(entries: GitHubEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.type === "dir").map((e) => e.name));
}
