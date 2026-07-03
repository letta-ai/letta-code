/**
 * Helpers for the /init slash command.
 *
 * Pure functions live here; App.tsx keeps the orchestration
 * (commandRunner, processConversation, setCommandRunning, etc.)
 */

import memoryPrinciplesMd from "@/agent/prompts/memory_principles.md";
import { getSnapshot as getSubagentSnapshot } from "@/agent/subagent-state";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import doctorPromptMd from "./doctor-prompt.md";
import { gatherGitContextSnapshot } from "./git-context";

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

/**
 * Detailed Memory Maintenance Principles, sans the auditor-voiced intro
 * (everything from the first numbered "## 1." section onward), so the doctor
 * prompt can present them in the primary agent's own voice.
 */
const MEMORY_PRINCIPLES_BODY = (() => {
  const idx = memoryPrinciplesMd.indexOf("## 1.");
  return (
    idx === -1 ? memoryPrinciplesMd : memoryPrinciplesMd.slice(idx)
  ).trim();
})();

/** Message for the primary agent via processConversation when user runs /doctor. */
export function buildDoctorMessage(args: { gitContext: string }): string {
  const today = new Date();
  const currentDate = `${today.toLocaleDateString("en-CA")} (${today.toLocaleDateString(
    "en-US",
    { weekday: "long" },
  )})`;
  const body = doctorPromptMd
    .replace("{{MEMORY_PRINCIPLES}}", MEMORY_PRINCIPLES_BODY)
    .replace("{{GIT_CONTEXT}}", args.gitContext)
    .replace("{{CURRENT_DATE}}", currentDate)
    .trim();

  return `${SYSTEM_REMINDER_OPEN}
${body}
${SYSTEM_REMINDER_CLOSE}`;
}
