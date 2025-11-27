import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getClient } from "../../agent/client";
import { createAgent } from "../../agent/create";
import { settingsManager } from "../../settings-manager";

// Skip these integration tests if LETTA_API_KEY is not set
const shouldSkip = !process.env.LETTA_API_KEY;
const describeOrSkip = shouldSkip ? describe.skip : describe;

describeOrSkip("createAgent init-blocks filtering", () => {
  let originalGlobalSharedBlockIds: Record<string, string>;
  let originalLocalSharedBlockIds: Record<string, string>;
  let createdAgentId: string | null = null;

  beforeAll(async () => {
    const apiKey = process.env.LETTA_API_KEY;
    if (!apiKey) {
      throw new Error("LETTA_API_KEY must be set to run this test");
    }

    await settingsManager.initialize();

    const settings = settingsManager.getSettings();
    await settingsManager.loadProjectSettings();
    const projectSettings = settingsManager.getProjectSettings();

    originalGlobalSharedBlockIds = { ...settings.globalSharedBlockIds };
    originalLocalSharedBlockIds = { ...projectSettings.localSharedBlockIds };
  });

  afterAll(async () => {
    const client = await getClient();

    if (createdAgentId) {
      try {
        await client.agents.delete(createdAgentId);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Restore original shared block mappings to avoid polluting user settings
    settingsManager.updateSettings({
      globalSharedBlockIds: originalGlobalSharedBlockIds,
    });
    settingsManager.updateProjectSettings(
      {
        localSharedBlockIds: originalLocalSharedBlockIds,
      },
      process.cwd(),
    );
  });

  test(
    "only requested memory blocks are created/registered",
    async () => {
      const agent = await createAgent(
        "init-blocks-test",
        undefined,
        "openai/text-embedding-3-small",
        undefined,
        true, // force new blocks instead of reusing shared ones
        undefined,
        true,
        false,
        undefined,
        ["persona", "skills"],
      );
      createdAgentId = agent.id;

      const settings = settingsManager.getSettings();
      await settingsManager.loadProjectSettings();
      const projectSettings = settingsManager.getProjectSettings();

      const globalIds = settings.globalSharedBlockIds;
      const localIds = projectSettings.localSharedBlockIds;

      // Requested blocks must be present
      expect(globalIds.persona).toBeDefined();
      expect(localIds.skills).toBeDefined();

      // No new GLOBAL shared blocks outside of the allowed set
      const newGlobalLabels = Object.keys(globalIds).filter(
        (label) => !(label in originalGlobalSharedBlockIds),
      );
      const disallowedGlobalLabels = newGlobalLabels.filter(
        (label) => label !== "persona",
      );
      expect(disallowedGlobalLabels.length).toBe(0);

      // No new LOCAL shared blocks outside of the allowed set
      const newLocalLabels = Object.keys(localIds).filter(
        (label) => !(label in originalLocalSharedBlockIds),
      );
      const disallowedLocalLabels = newLocalLabels.filter(
        (label) => label !== "skills",
      );
      expect(disallowedLocalLabels.length).toBe(0);
    },
    { timeout: 90000 },
  );
});
