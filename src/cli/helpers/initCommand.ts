/**
 * Helpers for the /init slash command.
 *
 * Pure functions live here; App.tsx keeps the orchestration
 * (commandRunner, processConversation, setCommandRunning, etc.)
 */

import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";
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

// ── Init subagent prompt helper ───────────────────────────

/** Prompt for the init subagent. */
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
