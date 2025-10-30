import { expect, test } from "bun:test";
import { createAgent } from "../agent/create";
import { getClient } from "../agent/client";

test("ephemeral agent lifecycle: create, retrieve, delete, verify gone", async () => {
  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing LETTA_API_KEY in env");
  }

  // Step 1: Create temp agent
  const agent = await createAgent("ephemeral-test-agent");
  expect(agent.id).toBeDefined();

  // Step 2: Verify agent exists
  const client = await getClient();
  const retrieved = await client.agents.retrieve(agent.id);
  expect(retrieved.id).toBe(agent.id);

  // Step 3: Delete agent (simulating --temp cleanup)
  await client.agents.delete(agent.id);

  // Step 4: Verify agent is gone
  await expect(client.agents.retrieve(agent.id)).rejects.toThrow();
});
