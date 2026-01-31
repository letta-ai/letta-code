/**
 * Integration tests for memory filesystem block tagging.
 * These tests hit the real Letta API and require LETTA_API_KEY to be set.
 *
 * Run with: bun test src/tests/agent/memoryFilesystem.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";

// Skip all tests if no API key is available
const LETTA_API_KEY = process.env.LETTA_API_KEY;
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || "https://api.letta.com";

const describeIntegration = LETTA_API_KEY ? describe : describe.skip;

describeIntegration("block tagging integration", () => {
  let client: Letta;
  let testAgentId: string;
  const createdBlockIds: string[] = [];

  beforeAll(async () => {
    client = new Letta({
      baseURL: LETTA_BASE_URL,
      apiKey: LETTA_API_KEY!,
    });

    // Create a test agent
    const agent = await client.agents.create({
      name: `memfs-test-${Date.now()}`,
      model: "letta/letta-free",
      embedding: "letta/letta-free",
    });
    testAgentId = agent.id;
  });

  afterAll(async () => {
    // Clean up: delete created blocks
    for (const blockId of createdBlockIds) {
      try {
        await client.blocks.delete(blockId);
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Delete test agent
    if (testAgentId) {
      try {
        await client.agents.delete(testAgentId);
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  test("block created with owner tag is discoverable via tag query", async () => {
    const ownerTag = `owner:${testAgentId}`;

    // Create a block with owner tag
    const block = await client.blocks.create({
      label: `test-tagged-${Date.now()}`,
      value: "Test content",
      tags: [ownerTag],
    });
    createdBlockIds.push(block.id);

    // Query blocks by owner tag
    const ownedBlocks = await client.blocks.list({ tags: [ownerTag] });
    const ownedBlocksArray = Array.isArray(ownedBlocks)
      ? ownedBlocks
      : (ownedBlocks as { items?: Array<{ id: string }> }).items || [];

    // Verify our block is in the results
    const found = ownedBlocksArray.some((b) => b.id === block.id);
    expect(found).toBe(true);
  });

  test("detached block remains discoverable via owner tag after detach", async () => {
    const ownerTag = `owner:${testAgentId}`;

    // Create and attach a block
    const block = await client.blocks.create({
      label: `test-detach-${Date.now()}`,
      value: "Test content for detach",
      tags: [ownerTag],
    });
    createdBlockIds.push(block.id);

    await client.agents.blocks.attach(block.id, { agent_id: testAgentId });

    // Verify it's attached
    const attachedBlocks = await client.agents.blocks.list(testAgentId);
    const attachedArray = Array.isArray(attachedBlocks)
      ? attachedBlocks
      : (attachedBlocks as { items?: Array<{ id: string }> }).items || [];
    expect(attachedArray.some((b) => b.id === block.id)).toBe(true);

    // Detach the block
    await client.agents.blocks.detach(block.id, { agent_id: testAgentId });

    // Verify it's no longer attached
    const afterDetach = await client.agents.blocks.list(testAgentId);
    const afterDetachArray = Array.isArray(afterDetach)
      ? afterDetach
      : (afterDetach as { items?: Array<{ id: string }> }).items || [];
    expect(afterDetachArray.some((b) => b.id === block.id)).toBe(false);

    // But it should still be discoverable via owner tag
    const ownedBlocks = await client.blocks.list({ tags: [ownerTag] });
    const ownedBlocksArray = Array.isArray(ownedBlocks)
      ? ownedBlocks
      : (ownedBlocks as { items?: Array<{ id: string }> }).items || [];
    expect(ownedBlocksArray.some((b) => b.id === block.id)).toBe(true);
  });

  test("backfill adds owner tag to existing block", async () => {
    const ownerTag = `owner:${testAgentId}`;

    // Create a block WITHOUT owner tag
    const block = await client.blocks.create({
      label: `test-backfill-${Date.now()}`,
      value: "Test content for backfill",
      // No tags
    });
    createdBlockIds.push(block.id);

    // Verify it's NOT discoverable via owner tag initially
    const beforeBackfill = await client.blocks.list({ tags: [ownerTag] });
    const beforeArray = Array.isArray(beforeBackfill)
      ? beforeBackfill
      : (beforeBackfill as { items?: Array<{ id: string }> }).items || [];
    expect(beforeArray.some((b) => b.id === block.id)).toBe(false);

    // Backfill: add owner tag
    await client.blocks.update(block.id, {
      tags: [ownerTag],
    });

    // Now it should be discoverable via owner tag
    const afterBackfill = await client.blocks.list({ tags: [ownerTag] });
    const afterArray = Array.isArray(afterBackfill)
      ? afterBackfill
      : (afterBackfill as { items?: Array<{ id: string }> }).items || [];
    expect(afterArray.some((b) => b.id === block.id)).toBe(true);
  });

  test("multiple agents can own the same block", async () => {
    const ownerTag1 = `owner:${testAgentId}`;
    const ownerTag2 = `owner:other-agent-${Date.now()}`;

    // Create a block with both owner tags (shared block)
    const block = await client.blocks.create({
      label: `test-shared-${Date.now()}`,
      value: "Shared content",
      tags: [ownerTag1, ownerTag2],
    });
    createdBlockIds.push(block.id);

    // Verify it's discoverable via both tags
    const owned1 = await client.blocks.list({ tags: [ownerTag1] });
    const owned1Array = Array.isArray(owned1)
      ? owned1
      : (owned1 as { items?: Array<{ id: string }> }).items || [];
    expect(owned1Array.some((b) => b.id === block.id)).toBe(true);

    const owned2 = await client.blocks.list({ tags: [ownerTag2] });
    const owned2Array = Array.isArray(owned2)
      ? owned2
      : (owned2 as { items?: Array<{ id: string }> }).items || [];
    expect(owned2Array.some((b) => b.id === block.id)).toBe(true);
  });
});
