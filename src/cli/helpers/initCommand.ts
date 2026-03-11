/**
 * Helpers for the /init slash command.
 *
 * Pure functions live here; App.tsx keeps the orchestration
 * (commandRunner, processConversation, setCommandRunning, etc.)
 */

import { execSync } from "node:child_process";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
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

// ── Depth instructions ────────────────────────────────────

const SHALLOW_INSTRUCTIONS = `
Shallow init — fast project basics only (~5 tool calls max):
- Only read: CLAUDE.md, AGENTS.md, package.json/pyproject.toml/Cargo.toml, README.md (first 100 lines), top-level directory listing
- Detect user identity from the git context provided above (already in the prompt — no extra calls)
- Run one git call: git log --format="%an <%ae>" | sort -u | head -5
- Write exactly 4 files: project/overview.md, project/commands.md, project/conventions.md, human/identity.md
- Skip: deep directory exploration, architecture mapping, config analysis, historical sessions, persona files, reflection/checkpoint phase
`.trim();

const DEEP_INSTRUCTIONS = `
Deep init — full exploration (follow the initializing-memory skill fully):
- Read all existing memory files first — do NOT recreate what already exists
- Then follow the full initializing-memory skill as your operating guide
- Expand and deepen existing shallow files, add new ones to reach 15-25 target
- If shallow init already ran, build on its output rather than starting over
`.trim();

// ── Prompt builders ────────────────────────────────────────

/** Prompt for the background init subagent (MemFS path). */
export function buildMemoryInitRuntimePrompt(args: {
  agentId: string;
  workingDirectory: string;
  memoryDir: string;
  gitContext: string;
  depth?: "shallow" | "deep";
}): string {
  const depth = args.depth ?? "deep";
  return `
The user ran /init for the current project.

Runtime context:
- parent_agent_id: ${args.agentId}
- working_directory: ${args.workingDirectory}
- memory_dir: ${args.memoryDir}
- research_depth: ${depth}

Git/project context:
${args.gitContext}

Task:
Initialize or reorganize the parent agent's filesystem-backed memory for this project.

${depth === "shallow" ? SHALLOW_INSTRUCTIONS : DEEP_INSTRUCTIONS}

Instructions:
- Use the pre-loaded initializing-memory skill as your operating guide
- Inspect existing memory before editing
- Base your decisions on the current repository and current memory contents
- Do not ask follow-up questions
- Make reasonable assumptions and report them
- If the memory filesystem is unavailable or unsafe to modify, stop and explain why
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
  const initPrompt = buildMemoryInitRuntimePrompt({
    agentId,
    workingDirectory: process.cwd(),
    memoryDir: getMemoryFilesystemRoot(agentId),
    gitContext,
    depth: "shallow",
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

// ── Interactive intake ─────────────────────────────────────

/** System-reminder message for the primary agent to run interactive intake. */
export function buildInitIntakeMessage(args: {
  gitContext: string;
  agentId: string;
  workingDirectory: string;
  memoryDir: string;
}): string {
  return `${SYSTEM_REMINDER_OPEN}
The user ran /init to initialize your memory for this project.

Your job: ask ONE bundled question to gather context, then dispatch a background init subagent.

## Step 1: Ask the user

Ask a single message with these questions bundled together:

1. **Research depth**: "Standard or deep research (comprehensive, as long as needed)?"
2. **Related repos**: "Are there other repositories I should know about and consider in my research?" (e.g., backend monorepo, shared libraries)
3. **Historical sessions**: "I found Claude Code / Codex history on your machine. Should I analyze it to learn your preferences, coding patterns, and project context? This significantly improves how I work with you but uses additional time and tokens." Options: "Yes, analyze history" / "Skip for now". Only include this question if history data exists — run \`ls ~/.claude/history.jsonl ~/.codex/history.jsonl 2>/dev/null\` first to check.
4. **Any specific rules**: "Rules I should always follow?"

Keep it conversational and short.

## Step 2: Dispatch background subagent

After the user answers, acknowledge their answers briefly, then use the **Task** tool to dispatch the init subagent:

\`\`\`
Task({
  subagent_type: "init",
  run_in_background: true,
  description: "Initializing memory",
  prompt: "<see below>"
})
\`\`\`

The Task prompt MUST include:
- All of the user's answers (research depth, related repos, historical sessions preference, rules)
- The runtime context below (copy it verbatim into the prompt)

### Runtime context (include in Task prompt)

- parent_agent_id: ${args.agentId}
- working_directory: ${args.workingDirectory}
- memory_dir: ${args.memoryDir}

${args.gitContext}

## Rules

- Do NOT invoke the \`initializing-memory\` skill yourself
- Do NOT do deep project research yourself — that's the subagent's job
- Do NOT read project files beyond what's needed to answer the user
- If the user says "skip" or "just do it", dispatch immediately with reasonable defaults
- The Task prompt should be self-contained — the subagent has no access to this conversation
${SYSTEM_REMINDER_CLOSE}`;
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
