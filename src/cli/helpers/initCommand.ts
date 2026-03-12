/**
 * Helpers for the /init slash command.
 *
 * Pure functions live here; App.tsx keeps the orchestration
 * (commandRunner, processConversation, setCommandRunning, etc.)
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getMemoryFilesystemRoot,
  getMemorySystemDir,
} from "../../agent/memoryFilesystem";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";
import { settingsManager } from "../../settings-manager";
import { getSnapshot as getSubagentSnapshot } from "./subagentState";

// ── Guard ──────────────────────────────────────────────────

export function hasActiveInitSubagent(): boolean {
  const snapshot = getSubagentSnapshot();
  return snapshot.agents.some(
    (agent) =>
      agent.type.toLowerCase() === "init" &&
      (agent.status === "pending" || agent.status === "running"),
  );
}

// ── Git context ────────────────────────────────────────────

export function gatherGitContext(): string {
  try {
    const cwd = process.cwd();

    try {
      execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });

      const branch = execSync("git branch --show-current", {
        cwd,
        encoding: "utf-8",
      }).trim();
      const mainBranch = execSync(
        "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo 'main'",
        { cwd, encoding: "utf-8", shell: "/bin/bash" },
      ).trim();
      const status = execSync("git status --short", {
        cwd,
        encoding: "utf-8",
      }).trim();
      const recentCommits = execSync(
        "git log --oneline -10 2>/dev/null || echo 'No commits yet'",
        { cwd, encoding: "utf-8" },
      ).trim();

      return `
- branch: ${branch}
- main: ${mainBranch}
- status: ${status || "(clean)"}

Recent commits:
${recentCommits}
`;
    } catch {
      return "(not a git repository)";
    }
  } catch {
    // execSync import failed (shouldn't happen with static import, but be safe)
    return "";
  }
}

// ── Shallow init (background subagent) ───────────────────

/** Gather git identity for the local user. */
function gatherGitIdentity(): string {
  const cwd = process.cwd();
  try {
    const userName = execSync("git config user.name 2>/dev/null || true", {
      cwd,
      encoding: "utf-8",
    }).trim();
    const userEmail = execSync("git config user.email 2>/dev/null || true", {
      cwd,
      encoding: "utf-8",
    }).trim();

    if (userName || userEmail) return `${userName} <${userEmail}>`;
    return "";
  } catch {
    return "";
  }
}

/** Read existing memory files from the local filesystem. */
function gatherExistingMemory(agentId: string): string {
  const systemDir = getMemorySystemDir(agentId);
  if (!existsSync(systemDir)) return "(empty)";

  const files: string[] = [];
  function walk(dir: string, prefix: string): void {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), rel);
        } else if (entry.name.endsWith(".md")) {
          try {
            const content = readFileSync(join(dir, entry.name), "utf-8");
            files.push(`── ${rel}\n${content.slice(0, 2000)}`);
          } catch {
            // skip unreadable files
          }
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }
  walk(systemDir, "");
  return files.length > 0 ? files.join("\n\n") : "(empty)";
}

/** Batch-check which paths are gitignored. Falls back to a hardcoded set. */
function getGitIgnored(cwd: string, names: string[]): Set<string> {
  if (names.length === 0) return new Set();
  try {
    const result = execSync("git check-ignore --stdin", {
      cwd,
      encoding: "utf-8",
      input: names.join("\n"),
    }).trim();
    return new Set(result.split("\n").filter(Boolean));
  } catch {
    // exit code 1 = no ignored paths, or not a git repo — fall back
    return new Set([
      "node_modules",
      "dist",
      "build",
      "__pycache__",
      "target",
      "vendor",
    ]);
  }
}

/** Get project directory structure as a tree (2 levels deep). */
function gatherDirListing(): string {
  const cwd = process.cwd();
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    const visible = entries.filter((e) => !e.name.startsWith("."));
    const ignored = getGitIgnored(
      cwd,
      visible.map((e) => e.name),
    );

    const dirs = visible
      .filter((e) => e.isDirectory() && !ignored.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = visible
      .filter((e) => !e.isDirectory() && !ignored.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const lines: string[] = [];
    const sorted = [...dirs, ...files];

    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i]!;
      const isLast = i === sorted.length - 1;
      const prefix = isLast ? "└── " : "├── ";

      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        try {
          const dirPath = join(cwd, entry.name);
          const childEntries = readdirSync(dirPath, {
            withFileTypes: true,
          }).filter((e) => !e.name.startsWith("."));
          const childIgnored = getGitIgnored(
            dirPath,
            childEntries.map((e) => e.name),
          );
          const children = childEntries
            .filter((e) => !childIgnored.has(e.name))
            .sort((a, b) => {
              if (a.isDirectory() !== b.isDirectory())
                return a.isDirectory() ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          const childPrefix = isLast ? "    " : "│   ";
          for (let j = 0; j < children.length; j++) {
            const child = children[j]!;
            const childIsLast = j === children.length - 1;
            const connector = childIsLast ? "└── " : "├── ";
            const suffix = child.isDirectory() ? "/" : "";
            lines.push(`${childPrefix}${connector}${child.name}${suffix}`);
          }
        } catch {
          // skip unreadable dirs
        }
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** Prompt for the background shallow-init subagent. */
export function buildShallowInitPrompt(args: {
  agentId: string;
  workingDirectory: string;
  memoryDir: string;
  gitContext: string;
  gitIdentity: string;
  existingMemory: string;
  dirListing: string;
}): string {
  const identityLine = args.gitIdentity
    ? `- git_user: ${args.gitIdentity}`
    : "";

  return `
## Environment

- working_directory: ${args.workingDirectory}
- memory_dir: ${args.memoryDir}
- parent_agent_id: ${args.agentId}
${identityLine}

## Git
${args.gitContext}

## Project Structure

\`\`\`
${args.dirListing}
\`\`\`

## Existing Memory

${args.existingMemory}
`.trim();
}

/**
 * Fire auto-init for a newly created agent.
 * Returns true if init was spawned, false if skipped (guard / memfs disabled).
 */
export async function fireAutoInit(
  agentId: string,
  onComplete: (result: {
    success: boolean;
    error?: string;
  }) => void | Promise<void>,
): Promise<boolean> {
  if (hasActiveInitSubagent()) return false;
  if (!settingsManager.isMemfsEnabled(agentId)) return false;

  const gitContext = gatherGitContext();
  const gitIdentity = gatherGitIdentity();
  const existingMemory = gatherExistingMemory(agentId);
  const dirListing = gatherDirListing();

  const initPrompt = buildShallowInitPrompt({
    agentId,
    workingDirectory: process.cwd(),
    memoryDir: getMemoryFilesystemRoot(agentId),
    gitContext,
    gitIdentity,
    existingMemory,
    dirListing,
  });

  const { spawnBackgroundSubagentTask } = await import("../../tools/impl/Task");
  spawnBackgroundSubagentTask({
    subagentType: "init",
    prompt: initPrompt,
    description: "Initializing memory",
    silentCompletion: true,
    onComplete,
  });

  return true;
}

// ── Interactive init (primary agent) ─────────────────────

/** Message for the primary agent via processConversation when user runs /init. */
export function buildInitMessage(args: {
  gitContext: string;
  memoryDir?: string;
}): string {
  const memfsSection = args.memoryDir
    ? `\n## Memory filesystem\n\nMemory filesystem is enabled. Memory directory: \`${args.memoryDir}\`\n`
    : "";

  return `${SYSTEM_REMINDER_OPEN}
The user has requested memory initialization via /init.
${memfsSection}
## 1. Invoke the initializing-memory skill

Use the \`Skill\` tool with \`skill: "initializing-memory"\` to load the comprehensive instructions for memory initialization.

If the skill fails to invoke, proceed with your best judgment based on these guidelines:
- Ask upfront questions (research depth, identity, related repos, workflow style)
- Research the project based on chosen depth
- Create/update memory blocks incrementally
- Reflect and verify completeness

## 2. Follow the skill instructions

Once invoked, follow the instructions from the \`initializing-memory\` skill to complete the initialization.
${args.gitContext}
${SYSTEM_REMINDER_CLOSE}`;
}
