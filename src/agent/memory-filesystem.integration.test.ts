/**
 * Integration tests for memory filesystem block tagging.
 * These tests hit the real Letta API and require
 * LETTA_RUN_API_INTEGRATION_TESTS=true plus LETTA_API_KEY.
 *
 * Run with: LETTA_RUN_API_INTEGRATION_TESTS=true bun test src/agent/memory-filesystem.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";

const LETTA_API_KEY = process.env.LETTA_API_KEY;
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || "https://api.letta.com";
const API_KEY = LETTA_API_KEY ?? "";
const RUN_API_INTEGRATION_TESTS =
  process.env.LETTA_RUN_API_INTEGRATION_TESTS === "true";

const describeIntegration =
  RUN_API_INTEGRATION_TESTS && LETTA_API_KEY ? describe : describe.skip;

describeIntegration("block tagging integration", () => {
  let client: Letta;
  let testAgentId: string;
  const createdBlockIds: string[] = [];

  beforeAll(async () => {
    client = new Letta({
      baseURL: LETTA_BASE_URL,
      apiKey: API_KEY,
    });

    const agent = await client.agents.create({
      name: `memfs-test-${Date.now()}`,
      model: "letta/letta-free",
      embedding: "letta/letta-free",
    });
    testAgentId = agent.id;
  });

  afterAll(async () => {
    for (const blockId of createdBlockIds) {
      try {
        await client.blocks.delete(blockId);
      } catch {
        // Ignore errors during cleanup
      }
    }

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

    const block = await client.blocks.create({
      label: `test-tagged-${Date.now()}`,
      value: "Test content",
      tags: [ownerTag],
    });
    createdBlockIds.push(block.id);

    const ownedBlocks = await client.blocks.list({ tags: [ownerTag] });
    const ownedBlocksArray = Array.isArray(ownedBlocks)
      ? ownedBlocks
      : (ownedBlocks as { items?: Array<{ id: string }> }).items || [];

    const found = ownedBlocksArray.some((b) => b.id === block.id);
    expect(found).toBe(true);
  });

  test("detached block remains discoverable via owner tag after detach", async () => {
    const ownerTag = `owner:${testAgentId}`;

    const block = await client.blocks.create({
      label: `test-detach-${Date.now()}`,
      value: "Test content for detach",
      tags: [ownerTag],
    });
    createdBlockIds.push(block.id);

    await client.agents.blocks.attach(block.id, { agent_id: testAgentId });

    const attachedBlocks = await client.agents.blocks.list(testAgentId);
    const attachedArray = Array.isArray(attachedBlocks)
      ? attachedBlocks
      : (attachedBlocks as { items?: Array<{ id: string }> }).items || [];
    expect(attachedArray.some((b) => b.id === block.id)).toBe(true);

    await client.agents.blocks.detach(block.id, { agent_id: testAgentId });

    const afterDetach = await client.agents.blocks.list(testAgentId);
    const afterDetachArray = Array.isArray(afterDetach)
      ? afterDetach
      : (afterDetach as { items?: Array<{ id: string }> }).items || [];
    expect(afterDetachArray.some((b) => b.id === block.id)).toBe(false);

    const ownedBlocks = await client.blocks.list({ tags: [ownerTag] });
    const ownedBlocksArray = Array.isArray(ownedBlocks)
      ? ownedBlocks
      : (ownedBlocks as { items?: Array<{ id: string }> }).items || [];
    expect(ownedBlocksArray.some((b) => b.id === block.id)).toBe(true);
  });

  test("backfill adds owner tag to existing block", async () => {
    const ownerTag = `owner:${testAgentId}`;

    const block = await client.blocks.create({
      label: `test-backfill-${Date.now()}`,
      value: "Test content for backfill",
    });
    createdBlockIds.push(block.id);

    const beforeBackfill = await client.blocks.list({ tags: [ownerTag] });
    const beforeArray = Array.isArray(beforeBackfill)
      ? beforeBackfill
      : (beforeBackfill as { items?: Array<{ id: string }> }).items || [];
    expect(beforeArray.some((b) => b.id === block.id)).toBe(false);

    await client.blocks.update(block.id, {
      tags: [ownerTag],
    });

    const afterBackfill = await client.blocks.list({ tags: [ownerTag] });
    const afterArray = Array.isArray(afterBackfill)
      ? afterBackfill
      : (afterBackfill as { items?: Array<{ id: string }> }).items || [];
    expect(afterArray.some((b) => b.id === block.id)).toBe(true);
  });

  test("multiple agents can own the same block", async () => {
    const ownerTag1 = `owner:${testAgentId}`;
    const ownerTag2 = `owner:other-agent-${Date.now()}`;

    const block = await client.blocks.create({
      label: `test-shared-${Date.now()}`,
      value: "Shared content",
      tags: [ownerTag1, ownerTag2],
    });
    createdBlockIds.push(block.id);

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
