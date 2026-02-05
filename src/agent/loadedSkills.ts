import { getClient } from "./client";
import { setHasLoadedSkills } from "./context";
import { parseMdxFrontmatter } from "./memory";
import { MEMORY_PROMPTS } from "./promptAssets";

const DEFAULT_LOADED_SKILLS_VALUE = (() => {
  const content = MEMORY_PROMPTS["loaded_skills.mdx"];
  if (!content) {
    return "No skills currently loaded.";
  }
  return parseMdxFrontmatter(content).body;
})();

type Client = Awaited<ReturnType<typeof getClient>>;

export async function clearLoadedSkillsForConversation(
  conversationId: string,
  clientOverride?: Client,
): Promise<void> {
  if (!conversationId || conversationId === "default") {
    return;
  }

  try {
    const client = clientOverride ?? (await getClient());
    const conversation = await client.conversations.retrieve(conversationId);
    const isolatedBlockIds = conversation.isolated_block_ids || [];

    for (const blockId of isolatedBlockIds) {
      try {
        const block = await client.blocks.retrieve(blockId);
        if (block.label !== "loaded_skills") {
          continue;
        }

        const value = typeof block.value === "string" ? block.value.trim() : "";
        if (value !== DEFAULT_LOADED_SKILLS_VALUE) {
          await client.blocks.update(blockId, {
            value: DEFAULT_LOADED_SKILLS_VALUE,
          });
        }

        setHasLoadedSkills(false);
        return;
      } catch {
        // Ignore block errors; continue searching.
      }
    }
  } catch {
    // Best-effort cleanup; ignore errors.
  }
}
