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
export async function fetchGitHubContents(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<GitHubEntry[]> {
  const apiPath = path
    ? `repos/${owner}/${repo}/contents/${path}?ref=${branch}`
    : `repos/${owner}/${repo}/contents?ref=${branch}`;

  // Try gh CLI (authenticated, 5000 req/hr)
  try {
    const { execSync } = await import("node:child_process");
    const result = execSync(`gh api ${apiPath}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return JSON.parse(result) as GitHubEntry[];
  } catch {
    // Fall back to unauthenticated API (60 req/hr)
  }

  // Try direct API
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
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
