import type { ReflectionMemoryWorktree } from "@/agent/memory-worktree";

export function buildReflectionIntegrationConversationTitle(
  reflectionSubagentId?: string,
): string {
  return reflectionSubagentId
    ? `Reflection integration (reflection ${reflectionSubagentId})`
    : "Reflection integration";
}

export function buildReflectionIntegrationPrompt(params: {
  worktree: ReflectionMemoryWorktree;
  instructions?: string;
  reflectionSubagentId?: string;
}): string {
  const instructions = params.instructions?.trim();
  return `Integrate proposed reflection changes into your memory.

The user configured explicit handling for reflection merges. You are responsible for the entire integration. Work autonomously in this separate conversation; do not interrupt or add messages to the original conversation.

Reflection worktree: ${params.worktree.worktreeDir}
Your memory repository: ${params.worktree.parentMemoryDir}
Reflection branch: ${params.worktree.branchName}
Reflection base commit: ${params.worktree.baseHead}
Original reflection subagent ID: ${params.reflectionSubagentId ?? "unavailable"}

Work in the reflection worktree while refining the proposal. Start directly by checking both repository states and the proposed diff in one combined shell call; do not create a task plan or spend turns narrating routine Git checks.

Review the proposal for accuracy, placement, precision, and consistency with existing memory, then make any needed edits. If no edits are needed, do not create another commit. If you edit the proposal, stage only those files and create one follow-up commit on top of the reflection commit; do not amend. Use the subject \`merge(reflection): <concise summary>\`.${params.reflectionSubagentId ? ` Include the trailer \`Reflection-Subagent-ID: ${params.reflectionSubagentId}\`.` : ""}

Before merging, incorporate the latest committed memory repository HEAD into the reflection branch and resolve conflicts yourself while preserving the intended memory state. If the memory repository has pre-existing uncommitted changes, leave them completely untouched—do not modify, stash, commit, or discard them—and stop the integration.

Merge the completed reflection branch into your memory repository without pushing, then verify both repositories are clean. Do not remove the worktree or branch; the harness performs final verification and cleanup.

Do not ask the user questions or wait for input. Handle the integration as far as you safely can and explain any remaining blocker in your final response. If integration remains incomplete, the harness will clean up this proposal without consuming the source transcript so reflection can retry later.

${instructions ? `## IMPORTANT: Additional reflection merge instructions from the user\n\nThe user explicitly configured the following instructions for this integration. Follow them carefully:\n\n<reflection-merge-instructions>\n${instructions}\n</reflection-merge-instructions>\n\n` : ""}When finished, provide a concise normal summary of what you reviewed, changed, and merged.`;
}
