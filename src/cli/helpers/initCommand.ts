/**
 * Helpers for the /init slash command.
 *
 * Pure functions live here; App.tsx keeps the orchestration
 * (commandRunner, processConversation, setCommandRunning, etc.)
 */

import { execSync } from "node:child_process";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";
import { getSnapshot as getSubagentSnapshot } from "./subagentState";

// ── Guard ──────────────────────────────────────────────────

/** Description prefix used when spawning init subagents, including the agent ID for scoping. */
export function initSubagentDescription(agentId: string): string {
  return `Initialize agent memory [${agentId}]`;
}

export function hasActiveInitSubagent(agentId: string): boolean {
  const snapshot = getSubagentSnapshot();
  const tag = `[${agentId}]`;
  return snapshot.agents.some(
    (agent) =>
      agent.type.toLowerCase() === "init" &&
      (agent.status === "pending" || agent.status === "running") &&
      agent.description.includes(tag),
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
## Current Project Context

**Working directory**: ${cwd}

### Git Status
- **Current branch**: ${branch}
- **Main branch**: ${mainBranch}
- **Status**:
${status || "(clean working tree)"}

### Recent Commits
${recentCommits}
`;
    } catch {
      return `
## Current Project Context

**Working directory**: ${cwd}
**Git**: Not a git repository
`;
    }
  } catch {
    // execSync import failed (shouldn't happen with static import, but be safe)
    return "";
  }
}

// ── Prompt builders ────────────────────────────────────────

/** Prompt for the background init subagent (MemFS path). */
export function buildMemoryInitRuntimePrompt(args: {
  agentId: string;
  workingDirectory: string;
  memoryDir: string;
  gitContext: string;
}): string {
  return `
The user ran /init for the current project.

Runtime context:
- parent_agent_id: ${args.agentId}
- working_directory: ${args.workingDirectory}
- memory_dir: ${args.memoryDir}

Git/project context:
${args.gitContext}

Task:
Initialize or reorganize the parent agent's filesystem-backed memory for this project.

Instructions:
- Use the pre-loaded initializing-memory skill as your operating guide
- Inspect existing memory before editing
- Base your decisions on the current repository and current memory contents
- Do not ask follow-up questions
- Make reasonable assumptions and report them
- If the memory filesystem is unavailable or unsafe to modify, stop and explain why
`.trim();
}

/** Message for the primary agent via processConversation (legacy non-MemFS path). */
export function buildLegacyInitMessage(args: {
  gitContext: string;
  memfsSection: string;
}): string {
  return `${SYSTEM_REMINDER_OPEN}
The user has requested memory initialization via /init.
${args.memfsSection}
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
