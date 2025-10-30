import { expect, test } from "bun:test";
import { $ } from "bun";
import { getClient } from "../agent/client";
import { loadProjectSettings } from "../project-settings";

test("CLI --temp flag: settings unchanged and agent deleted", async () => {
  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing LETTA_API_KEY in env");
  }

  // Step 1: Record settings before
  const settingsBefore = await loadProjectSettings();
  const agentBefore = settingsBefore?.lastAgent;

  // Step 2: Run CLI with --temp flag
  const result =
    await $`bun run dev -- --temp -p "hello world" --output-format json --yolo`.text();
  const output = JSON.parse(result) as { agent_id: string; result: string };

  expect(output.agent_id).toBeDefined();
  expect(output.result).toBeDefined();

  // Step 3: Verify settings unchanged
  const settingsAfter = await loadProjectSettings();
  const agentAfter = settingsAfter?.lastAgent;
  expect(agentAfter).toBe(agentBefore);

  // Step 4: Verify agent is deleted
  const client = await getClient();
  await expect(client.agents.retrieve(output.agent_id)).rejects.toThrow();
});
