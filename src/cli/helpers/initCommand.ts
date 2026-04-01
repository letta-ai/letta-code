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
import { gatherGitContextSnapshot } from "./gitContext";
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

export function gatherInitGitContext(): { context: string; identity: string } {
  try {
    const git = gatherGitContextSnapshot({
      recentCommitLimit: 10,
    });
    if (!git.isGitRepo) {
      return {
        context: "(not a git repository)",
        identity: "",
      };
    }

    return {
      context: `
- branch: ${git.branch ?? "(unknown)"}
- status: ${git.status || "(clean)"}

Recent commits:
${git.recentCommits || "No commits yet"}
`,
      identity: git.gitUser ?? "",
    };
  } catch {
    return {
      context: "",
      identity: "",
    };
  }
}

// ── Shallow init (background subagent) ───────────────────

/** Read existing memory files from the local filesystem. */
function gatherExistingMemory(agentId: string): {
  paths: string[];
  contents: string;
} {
  const systemDir = getMemorySystemDir(agentId);
  if (!existsSync(systemDir)) return { paths: [], contents: "" };

  const paths: string[] = [];
  const sections: string[] = [];
  function walk(dir: string, prefix: string): void {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), rel);
        } else if (entry.name.endsWith(".md")) {
          try {
            const content = readFileSync(join(dir, entry.name), "utf-8");
            paths.push(rel);
            sections.push(`── ${rel}\n${content.slice(0, 2000)}`);
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
  return { paths, contents: sections.join("\n\n") };
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

    for (const [i, entry] of sorted.entries()) {
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
          for (const [j, child] of children.entries()) {
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
  gitIdentity: string;
  existingMemoryPaths: string[];
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

## Project Structure

\`\`\`
${args.dirListing}
\`\`\`

## Existing Memory

${args.existingMemoryPaths.length > 0 ? `Paths:\n${args.existingMemoryPaths.map((p) => `- ${p}`).join("\n")}\n\nContents:\n${args.existingMemory}` : "(empty)"}
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

  const gitDetails = gatherInitGitContext();
  const existing = gatherExistingMemory(agentId);
  const dirListing = gatherDirListing();

  const initPrompt = buildShallowInitPrompt({
    agentId,
    workingDirectory: process.cwd(),
    memoryDir: getMemoryFilesystemRoot(agentId),
    gitIdentity: gitDetails.identity,
    existingMemoryPaths: existing.paths,
    existingMemory: existing.contents,
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

/** Message for the primary agent via processConversation when user runs /doctor. */
export function buildDoctorMessage(args: {
  gitContext: string;
  memoryDir?: string;
}): string {
  const memfsSection = args.memoryDir
    ? `\n## Memory filesystem\n\nMemory filesystem is enabled. Memory directory: \`${args.memoryDir}\`\n`
    : "";

  return `${SYSTEM_REMINDER_OPEN}
The user has requested a memory structure check via /doctor.
${memfsSection}
## 1. Invoke the context_doctor skill

Use the \`Skill\` tool with \`skill: "context_doctor"\` to load guidance for memory structure refinement.

## 2. Follow the skill instructions

Once invoked, follow the instructions from the \`context_doctor\` skill.

${args.gitContext}
${SYSTEM_REMINDER_CLOSE}`;
}
