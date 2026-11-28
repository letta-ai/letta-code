import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { buildClientSkillsPayload } from "@/agent/client-skills";
import { getGlobalSkillsDir } from "@/agent/skills";
import { getBackend } from "@/backend";
import { getAgentContextOverview } from "@/backend/api/agents";
import { collectLocalMemoryContextData } from "@/web/local-memory-context";
import { getConversationWorkingDirectory } from "@/websocket/listener/cwd";
import type { ConversationRuntime } from "@/websocket/listener/types";

export async function terminalSkills(runtime: ConversationRuntime) {
  const { availableSkills } = await buildClientSkillsPayload({
    agentId: runtime.agentId ?? undefined,
    workingDirectory: getConversationWorkingDirectory(
      runtime.listener,
      runtime.agentId,
      runtime.conversationId,
    ),
    skillSources: runtime.skillSources,
    bundledSkills: runtime.bundledSkills,
    cloudSkillRepositories: runtime.executionSettings?.cloud_skill_repositories,
  });
  runtime.currentAvailableSkills = availableSkills;
  return inspectSkillDirectories(availableSkills);
}

export function inspectSkillDirectories(
  availableSkills: Pick<
    ConversationRuntime["currentAvailableSkills"][number],
    "name" | "path" | "description"
  >[],
) {
  return Promise.all(
    availableSkills.map(async (skill) => {
      const directory =
        basename(skill.path) === "SKILL.md" ? dirname(skill.path) : skill.path;
      const path = await realpath(directory).catch(() => directory);
      const name = basename(directory);
      const link = join(getGlobalSkillsDir(), name);
      const stat = await lstat(link).catch(() => undefined);
      const enabled =
        stat?.isSymbolicLink() &&
        (await realpath(link).catch(() => undefined)) === path;
      return {
        name,
        path,
        label: skill.name,
        description: skill.description,
        enabled: !!enabled,
        fixed: !!stat && !enabled,
      };
    }),
  );
}

export async function terminalContext(runtime: ConversationRuntime) {
  const agentId = runtime.agentId;
  if (!agentId) throw new Error("Select an agent to inspect context");
  if (getBackend().capabilities.localMemfs) {
    const { context } = await collectLocalMemoryContextData(
      agentId,
      runtime.conversationId,
    );
    if (!context) throw new Error("Context unavailable");
    return [
      `Estimated conversation context: ${context.usedTokens} / ${context.contextWindow} tokens`,
      `System: ${context.breakdown.system}`,
      `Messages: ${context.breakdown.messages}`,
    ].join("\n");
  }
  const overview =
    await getAgentContextOverview<Record<string, number>>(agentId);
  return [
    `Agent context: ${overview.context_window_size_current} / ${overview.context_window_size_max} tokens`,
    ...Object.entries(overview)
      .filter(
        ([key, value]) =>
          key.startsWith("num_tokens_") && typeof value === "number",
      )
      .map(([key, value]) => `${key.slice(11).replaceAll("_", " ")}: ${value}`),
  ].join("\n");
}
