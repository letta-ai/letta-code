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

export const INIT_TASK_DESCRIPTION_STANDARD = "Memory init standard";
export const INIT_TASK_DESCRIPTION_DEEP = "Memory init deep";

const INTERACTIVE_INIT_TASK_DESCRIPTIONS = new Set(
  [INIT_TASK_DESCRIPTION_STANDARD, INIT_TASK_DESCRIPTION_DEEP].map((value) =>
    value.toLowerCase(),
  ),
);

const ACTIVE_INIT_TASK_DESCRIPTIONS = new Set([
  ...INTERACTIVE_INIT_TASK_DESCRIPTIONS,
  "initializing memory",
  "deep memory initialization",
]);

function normalizeDescription(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

// ── Guard ──────────────────────────────────────────────────

export function hasActiveInitSubagent(): boolean {
  const snapshot = getSubagentSnapshot();
  return snapshot.agents.some(
    (agent) =>
      (agent.type.toLowerCase() === "init" ||
        ACTIVE_INIT_TASK_DESCRIPTIONS.has(
          normalizeDescription(agent.description),
        )) &&
      (agent.status === "pending" || agent.status === "running"),
  );
}

export function isInteractiveInitTaskDescription(description: string): boolean {
  return INTERACTIVE_INIT_TASK_DESCRIPTIONS.has(
    normalizeDescription(description),
  );
}

export function inferInteractiveInitDepth(
  description: string,
): "shallow" | "deep" | null {
  const normalized = normalizeDescription(description);
  if (normalized === INIT_TASK_DESCRIPTION_STANDARD.toLowerCase()) {
    return "shallow";
  }
  if (normalized === INIT_TASK_DESCRIPTION_DEEP.toLowerCase()) {
    return "deep";
  }
  return null;
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

function buildIntakeSummarySection(intakeSummary?: string): string {
  if (!intakeSummary) {
    return "User intake summary: (none provided; infer from repository context)";
  }
  return `User intake summary:
${intakeSummary}`;
}

export interface MemoryInitRuntimePromptArgs {
  agentId: string;
  workingDirectory: string;
  memoryDir: string;
  gitContext: string;
  depth?: "shallow" | "deep";
  intakeSummary?: string;
}

/** Prompt for the background init subagent (MemFS path). */
export function buildMemoryInitRuntimePrompt(
  args: MemoryInitRuntimePromptArgs,
): string {
  const depth = args.depth ?? "deep";
  return `
The user ran /init for the current project.

Runtime context:
- parent_agent_id: ${args.agentId}
- working_directory: ${args.workingDirectory}
- memory_dir: ${args.memoryDir}
- research_depth: ${depth}

${buildIntakeSummarySection(args.intakeSummary)}

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

export interface LegacyInitRuntimePromptArgs {
  agentId: string;
  workingDirectory: string;
  gitContext: string;
  depth?: "shallow" | "deep";
  intakeSummary?: string;
}

/** Prompt for non-MemFS background init (deploys the existing parent agent). */
export function buildLegacyMemoryInitRuntimePrompt(
  args: LegacyInitRuntimePromptArgs,
): string {
  const depth = args.depth ?? "deep";
  return `
The user ran /init for the current project.

Runtime context:
- target_agent_id: ${args.agentId}
- working_directory: ${args.workingDirectory}
- memory_mode: legacy-api
- research_depth: ${depth}

${buildIntakeSummarySection(args.intakeSummary)}

Git/project context:
${args.gitContext}

Task:
Initialize or reorganize this agent's API-backed memory for the project.

${depth === "shallow" ? SHALLOW_INSTRUCTIONS : DEEP_INSTRUCTIONS}

Instructions:
- Invoke the \`initializing-memory\` skill first with \`Skill({ skill: "initializing-memory" })\`
- Then follow that skill autonomously to update memory blocks for this agent
- Do not ask follow-up questions (intake is already complete)
- Do not launch additional Task subagents
- Make reasonable assumptions and report them
`.trim();
}

export interface InitIntakeMessageArgs {
  agentId: string;
  workingDirectory: string;
  memfsEnabled: boolean;
  memoryDir: string;
  gitContext: string;
}

/**
 * Command-scoped reminder for interactive /init intake in the primary agent.
 * The primary agent asks questions, then dispatches background labor.
 */
export function buildInitIntakeMessage(args: InitIntakeMessageArgs): string {
  const modeSpecificDispatch = args.memfsEnabled
    ? `\`\`\`ts
Task({
  subagent_type: "init",
  description: depth === "deep" ? "${INIT_TASK_DESCRIPTION_DEEP}" : "${INIT_TASK_DESCRIPTION_STANDARD}",
  run_in_background: true,
  prompt: "<build from intake using the runtime template below>"
})
\`\`\`

Use this worker prompt template:
\`\`\`
${buildMemoryInitRuntimePrompt({
  agentId: args.agentId,
  workingDirectory: args.workingDirectory,
  memoryDir: args.memoryDir,
  gitContext: args.gitContext,
  depth: "deep",
  intakeSummary:
    "- identity: <answer>\n- related_repos: <answer>\n- communication_or_rules: <answer>",
})}
\`\`\``
    : `\`\`\`ts
Task({
  subagent_type: "general-purpose",
  agent_id: "${args.agentId}",
  description: depth === "deep" ? "${INIT_TASK_DESCRIPTION_DEEP}" : "${INIT_TASK_DESCRIPTION_STANDARD}",
  run_in_background: true,
  prompt: "<build from intake using the runtime template below>"
})
\`\`\`

Use this worker prompt template:
\`\`\`
${buildLegacyMemoryInitRuntimePrompt({
  agentId: args.agentId,
  workingDirectory: args.workingDirectory,
  gitContext: args.gitContext,
  depth: "deep",
  intakeSummary:
    "- identity: <answer>\n- related_repos: <answer>\n- communication_or_rules: <answer>",
})}
\`\`\``;

  return `${SYSTEM_REMINDER_OPEN}
The user explicitly ran /init and wants an interactive setup flow.

You are the primary agent for intake only. Follow this sequence:
1. Ask ONE AskUserQuestion bundle (max 4 total questions).
2. Wait for answers, then dispatch the real work in a background Task.
3. Tell the user initialization is running in the background.

Constraints:
- Do NOT do deep project research in this foreground turn.
- Do NOT invoke \`initializing-memory\` in this foreground turn.
- Ask no more than 4 questions total.
- Include a required depth question with exactly two options:
  - "Standard research" (maps to \`research_depth: shallow\`)
  - "Deep research" (maps to \`research_depth: deep\`)
- Use \`run_in_background: true\` (init/reflection background workflows use silent completion automatically).
- Use exactly one of these Task descriptions:
  - ${INIT_TASK_DESCRIPTION_STANDARD}
  - ${INIT_TASK_DESCRIPTION_DEEP}
- Dispatch exactly one background Task.

Runtime context:
- parent_agent_id: ${args.agentId}
- working_directory: ${args.workingDirectory}
- memory_mode: ${args.memfsEnabled ? "memfs" : "legacy-api"}
- memory_dir: ${args.memoryDir}

After intake, dispatch the background worker:
${modeSpecificDispatch}

Before dispatching, replace all placeholder values (\`<answer>\`, \`<build from intake>\`) with real intake answers and selected depth.
${SYSTEM_REMINDER_CLOSE}`;
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
