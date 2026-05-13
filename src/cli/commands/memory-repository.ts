/**
 * /memory-repository command handler.
 *
 * Configures an additional git remote that the memfs repo pushes to after
 * every commit. Backed by per-repo git config (`letta.memoryRepository.url`)
 * and a post-commit hook installed by src/agent/memoryGit.ts.
 *
 * Usage:
 *   /memory-repository set <url>    Configure a remote URL
 *   /memory-repository unset        Remove the configured URL
 *   /memory-repository status       Show current URL + tail of push log
 *   /memory-repository push         Force a push now (useful after a failure)
 *   /memory-repository help         Show usage
 */

import { getCurrentAgentId } from "../../agent/context";
import {
  getMemoryRepositoryUrl,
  type MemoryRepositoryPushResult,
  pushToMemoryRepository,
  readMemoryRepositoryPushLog,
  setMemoryRepositoryUrl,
  unsetMemoryRepositoryUrl,
} from "../../agent/memoryGit";

export interface MemoryRepositoryCommandResult {
  output: string;
}

const INITIAL_PUSH_TIMEOUT_MS = 10_000;

function resolveAgentId(): string | null {
  try {
    const scoped = getCurrentAgentId().trim();
    if (scoped) {
      return scoped;
    }
  } catch {
    // Fall through to env.
  }
  const fromEnv = (
    process.env.LETTA_AGENT_ID ||
    process.env.AGENT_ID ||
    ""
  ).trim();
  return fromEnv || null;
}

const HELP_TEXT = `Memory repository commands:

  /memory-repository set <url>    Configure an additional git remote
  /memory-repository unset        Remove the configured URL
  /memory-repository status       Show current URL + recent push log
  /memory-repository push         Force a push to the configured URL now

Your agent's memory repo will push to this URL after every commit, in addition
to the Letta server. The URL is stored in the memfs repo's local git config
(letta.memoryRepository.url) so each agent has its own setting.

Auth uses your existing git credentials — SSH keys, credential helpers, or
tokens in the URL. Letta does not store tokens for this feature.

Examples:
  /memory-repository set git@github.com:you/my-memory.git
  /memory-repository set https://github.com/you/my-memory.git
  /memory-repository status
  /memory-repository unset`;

/**
 * Normalize a user-provided URL. Accepts:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   any other git-recognized URL form
 * Strips trailing slashes. Does not force `.git` — git accepts both.
 */
function normalizeRepositoryUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function redactUrl(value: string): string {
  return value.replace(/https:\/\/([^:\s/@]+):([^@\s]+)@/gi, (match) =>
    match.replace(/:([^:@]+)@$/, ":***@"),
  );
}

async function pushToMemoryRepositoryWithTimeout(
  agentId: string,
): Promise<MemoryRepositoryPushResult | "timeout"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pushToMemoryRepository(agentId),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), INITIAL_PUSH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function handleMemoryRepositoryCommand(
  args: string[],
): Promise<MemoryRepositoryCommandResult> {
  const agentId = resolveAgentId();
  if (!agentId) {
    return {
      output:
        "No agent is currently selected. Open an agent first, then run /memory-repository again.",
    };
  }
  const [subcommand, ...rest] = args;

  switch ((subcommand ?? "").toLowerCase()) {
    case "set": {
      const rawUrl = rest.join(" ").trim();
      if (!rawUrl) {
        return { output: "Usage: /memory-repository set <url>" };
      }
      const url = normalizeRepositoryUrl(rawUrl);
      if (!url) {
        return { output: "Usage: /memory-repository set <url>" };
      }
      const displayUrl = redactUrl(url);

      try {
        await setMemoryRepositoryUrl(agentId, url);
      } catch (err) {
        return {
          output: `Failed to set memory-repository URL: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Best-effort initial push so the user gets immediate feedback about
      // auth/connectivity issues, bounded so the slash command stays responsive.
      const push = await pushToMemoryRepositoryWithTimeout(agentId);
      if (push === "timeout") {
        return {
          output: `Memory-repository URL set to ${displayUrl}.\nInitial push still running — check /memory-repository status for result.`,
        };
      }
      if (push.ok) {
        return {
          output: `Memory-repository URL set to ${displayUrl}.\nInitial push succeeded.`,
        };
      }
      return {
        output: `Memory-repository URL set to ${displayUrl}.\nInitial push failed:\n${redactUrl(push.output)}\n\nFix the issue and run /memory-repository push to retry, or just wait for the next commit.`,
      };
    }

    case "unset":
    case "remove":
    case "delete":
    case "rm": {
      const existing = await getMemoryRepositoryUrl(agentId);
      if (!existing) {
        return { output: "No memory-repository URL was configured." };
      }
      await unsetMemoryRepositoryUrl(agentId);
      return {
        output: `Memory-repository URL removed (was ${redactUrl(existing)}).`,
      };
    }

    case "status": {
      const url = await getMemoryRepositoryUrl(agentId);
      if (!url) {
        return {
          output:
            "No memory-repository URL configured.\nUse /memory-repository set <url> to configure one.",
        };
      }
      const log = redactUrl(readMemoryRepositoryPushLog(agentId, 20));
      const logSection = log
        ? `\n\nRecent push log:\n${log}`
        : "\n\n(no commits have triggered the hook yet)";
      return {
        output: `Memory-repository URL: ${redactUrl(url)}${logSection}`,
      };
    }

    case "push": {
      const result = await pushToMemoryRepository(agentId);
      if (result.ok) {
        return {
          output: `Pushed ${result.branch} to ${redactUrl(result.url ?? "")}.\n${redactUrl(result.output)}`,
        };
      }
      return { output: `Push failed:\n${redactUrl(result.output)}` };
    }

    case "":
    case undefined:
    case "help":
      return { output: HELP_TEXT };

    default:
      return {
        output: `Unknown subcommand '${subcommand}'.\n\n${HELP_TEXT}`,
      };
  }
}
