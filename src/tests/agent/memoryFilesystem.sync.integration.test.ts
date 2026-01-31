/**
 * Integration tests for memory filesystem sync behavior.
 * These tests hit the real Letta API and require LETTA_API_KEY to be set.
 *
 * Tests cover:
 * - Bug 1: File move from system/ to root/ (should detach, not duplicate)
 * - Bug 2: File deletion (should remove owner tag, not resurrect)
 * - FS wins all policy (when both changed, file wins)
 * - Location mismatch auto-sync
 *
 * Run with: bun test src/tests/agent/memoryFilesystem.sync.integration.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Letta from "@letta-ai/letta-client";

import {
  checkMemoryFilesystemStatus,
  ensureMemoryFilesystemDirs,
  getMemoryDetachedDir,
  getMemorySystemDir,
  syncMemoryFilesystem,
} from "../../agent/memoryFilesystem";
import { settingsManager } from "../../settings-manager";

// Skip all tests if no API key is available
const LETTA_API_KEY = process.env.LETTA_API_KEY;
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || "https://api.letta.com";
const API_KEY = LETTA_API_KEY ?? "";

const describeIntegration = LETTA_API_KEY ? describe : describe.skip;

describeIntegration("memfs sync integration", () => {
  let client: Letta;
  let testAgentId: string;
  let tempHomeDir: string;
  let originalHome: string | undefined;
  const createdBlockIds: string[] = [];

  beforeAll(async () => {
    client = new Letta({
      baseURL: LETTA_BASE_URL,
      apiKey: API_KEY,
    });

    // Create a test agent
    const agent = await client.agents.create({
      name: `memfs-sync-test-${Date.now()}`,
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

  beforeEach(async () => {
    // Reset settings manager before changing HOME
    await settingsManager.reset();

    // Create temp directory and override HOME
    tempHomeDir = join(tmpdir(), `memfs-sync-test-${Date.now()}`);
    mkdirSync(tempHomeDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tempHomeDir;

    // Create settings with API base URL
    // API key is read from process.env.LETTA_API_KEY by getClient()
    const settingsDir = join(tempHomeDir, ".letta");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        env: {
          LETTA_BASE_URL: LETTA_BASE_URL,
        },
      }),
    );

    // Initialize settings manager with new HOME
    await settingsManager.initialize();

    // Set up memfs directories
    ensureMemoryFilesystemDirs(testAgentId, tempHomeDir);
  });

  afterEach(async () => {
    // Reset settings manager
    await settingsManager.reset();

    // Restore HOME
    process.env.HOME = originalHome;

    // Clean up temp directory
    if (tempHomeDir && existsSync(tempHomeDir)) {
      rmSync(tempHomeDir, { recursive: true, force: true });
    }
  });

  function getSystemDir(): string {
    return getMemorySystemDir(testAgentId, tempHomeDir);
  }

  function getDetachedDir(): string {
    return getMemoryDetachedDir(testAgentId, tempHomeDir);
  }

  function writeSystemFile(label: string, content: string): void {
    const systemDir = getSystemDir();
    const filePath = join(systemDir, `${label}.md`);
    const dir = join(systemDir, ...label.split("/").slice(0, -1));
    if (label.includes("/")) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, content);
  }

  function writeDetachedFile(label: string, content: string): void {
    const detachedDir = getDetachedDir();
    const filePath = join(detachedDir, `${label}.md`);
    const dir = join(detachedDir, ...label.split("/").slice(0, -1));
    if (label.includes("/")) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, content);
  }

  function deleteFile(dir: string, label: string): void {
    const filePath = join(dir, `${label}.md`);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
  }

  function readFile(dir: string, label: string): string | null {
    const filePath = join(dir, `${label}.md`);
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf-8");
    }
    return null;
  }

  async function getAttachedBlocks(): Promise<
    Array<{ id: string; label?: string; value?: string }>
  > {
    const blocks = await client.agents.blocks.list(testAgentId);
    return Array.isArray(blocks)
      ? blocks
      : (
          blocks as {
            items?: Array<{ id: string; label?: string; value?: string }>;
          }
        ).items || [];
  }

  async function getOwnedBlocks(): Promise<
    Array<{ id: string; label?: string; value?: string; tags?: string[] }>
  > {
    const ownerTag = `owner:${testAgentId}`;
    const blocks = await client.blocks.list({ tags: [ownerTag] });
    return Array.isArray(blocks)
      ? blocks
      : (
          blocks as {
            items?: Array<{
              id: string;
              label?: string;
              value?: string;
              tags?: string[];
            }>;
          }
        ).items || [];
  }

  test("new file in system/ creates attached block", async () => {
    const label = `test-new-file-${Date.now()}`;
    const content = "New file content";

    // Create file in system/
    writeSystemFile(label, content);

    // Sync
    const result = await syncMemoryFilesystem(testAgentId, {
      homeDir: tempHomeDir,
    });

    // Verify block was created
    expect(result.createdBlocks).toContain(label);

    // Verify block is attached
    const attachedBlocks = await getAttachedBlocks();
    const block = attachedBlocks.find((b) => b.label === label);
    expect(block).toBeDefined();
    expect(block?.value).toBe(content);

    // Track for cleanup
    if (block?.id) {
      createdBlockIds.push(block.id);
    }
  });

  test("new file at root creates detached block (not attached)", async () => {
    const label = `test-detached-${Date.now()}`;
    const content = "Detached file content";

    // Create file at root (detached)
    writeDetachedFile(label, content);

    // Sync
    const result = await syncMemoryFilesystem(testAgentId, {
      homeDir: tempHomeDir,
    });

    // Verify block was created
    expect(result.createdBlocks).toContain(label);

    // Verify block is NOT attached
    const attachedBlocks = await getAttachedBlocks();
    const attachedBlock = attachedBlocks.find((b) => b.label === label);
    expect(attachedBlock).toBeUndefined();

    // Verify block exists via owner tag (detached)
    const ownedBlocks = await getOwnedBlocks();
    const ownedBlock = ownedBlocks.find((b) => b.label === label);
    expect(ownedBlock).toBeDefined();
    expect(ownedBlock?.value).toBe(content);

    // Track for cleanup
    if (ownedBlock?.id) {
      createdBlockIds.push(ownedBlock.id);
    }
  });

  test("file move from system/ to root/ detaches block (no duplication)", async () => {
    const label = `test-move-${Date.now()}`;
    const content = "Content that will be moved";

    // Create file in system/
    writeSystemFile(label, content);

    // First sync - creates attached block
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });

    // Verify block is attached
    let attachedBlocks = await getAttachedBlocks();
    let block = attachedBlocks.find((b) => b.label === label);
    expect(block).toBeDefined();
    if (block?.id) {
      createdBlockIds.push(block.id);
    }

    // Move file: delete from system/, create at root
    deleteFile(getSystemDir(), label);
    writeDetachedFile(label, content);

    // Second sync - should detach (location mismatch with same content)
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });

    // Verify block is no longer attached
    attachedBlocks = await getAttachedBlocks();
    block = attachedBlocks.find((b) => b.label === label);
    expect(block).toBeUndefined();

    // Verify only ONE block exists with this label (no duplication)
    const ownedBlocks = await getOwnedBlocks();
    const matchingBlocks = ownedBlocks.filter((b) => b.label === label);
    expect(matchingBlocks.length).toBe(1);

    // Verify the block still exists (just detached)
    expect(matchingBlocks[0]?.value).toBe(content);
  });

  test("file deletion removes owner tag (no resurrection)", async () => {
    const label = `test-delete-${Date.now()}`;
    const content = "Content that will be deleted";

    // Create file at root (detached)
    writeDetachedFile(label, content);

    // First sync - creates detached block with owner tag
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });

    // Verify block exists via owner tag
    let ownedBlocks = await getOwnedBlocks();
    let block = ownedBlocks.find((b) => b.label === label);
    expect(block).toBeDefined();
    const blockId = block?.id;
    if (blockId) {
      createdBlockIds.push(blockId);
    }

    // Delete the file
    deleteFile(getDetachedDir(), label);

    // Second sync - should remove owner tag
    const result = await syncMemoryFilesystem(testAgentId, {
      homeDir: tempHomeDir,
    });
    expect(result.deletedBlocks).toContain(label);

    // Verify block no longer has owner tag (not discoverable)
    ownedBlocks = await getOwnedBlocks();
    block = ownedBlocks.find((b) => b.label === label);
    expect(block).toBeUndefined();

    // Third sync - file should NOT resurrect
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });
    const fileContent = readFile(getDetachedDir(), label);
    expect(fileContent).toBeNull();
  });

  test("FS wins all: when both file and block changed, file wins", async () => {
    const label = `test-fs-wins-${Date.now()}`;
    const originalContent = "Original content";
    const fileContent = "File changed content";
    const blockContent = "Block changed content";

    // Create file in system/
    writeSystemFile(label, originalContent);

    // First sync - creates block
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });

    let attachedBlocks = await getAttachedBlocks();
    let block = attachedBlocks.find((b) => b.label === label);
    expect(block).toBeDefined();
    if (!block?.id) {
      throw new Error("Expected block to exist after first sync.");
    }
    const blockId = block.id;
    createdBlockIds.push(blockId);

    // Change both file AND block
    writeSystemFile(label, fileContent);
    await client.blocks.update(blockId, { value: blockContent });

    // Second sync - file should win (no conflict)
    const result = await syncMemoryFilesystem(testAgentId, {
      homeDir: tempHomeDir,
    });

    // Verify no conflicts
    expect(result.conflicts.length).toBe(0);
    expect(result.updatedBlocks).toContain(label);

    // Verify block has FILE content (not block content)
    attachedBlocks = await getAttachedBlocks();
    block = attachedBlocks.find((b) => b.label === label);
    expect(block?.value).toBe(fileContent);
  });

  test("location mismatch auto-sync: content matches but location differs", async () => {
    const label = `test-location-${Date.now()}`;
    const content = "Same content";

    // Create file in system/
    writeSystemFile(label, content);

    // First sync - creates attached block
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });

    let attachedBlocks = await getAttachedBlocks();
    let block = attachedBlocks.find((b) => b.label === label);
    expect(block).toBeDefined();
    const blockId = block?.id;
    if (blockId) {
      createdBlockIds.push(blockId);
    }

    // Move file to root (content unchanged)
    deleteFile(getSystemDir(), label);
    writeDetachedFile(label, content);

    // Second sync - should detach block (location mismatch with same content)
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });

    // Verify block is no longer attached
    attachedBlocks = await getAttachedBlocks();
    block = attachedBlocks.find((b) => b.label === label);
    expect(block).toBeUndefined();

    // Verify block still exists (detached)
    const ownedBlocks = await getOwnedBlocks();
    const detachedBlock = ownedBlocks.find((b) => b.label === label);
    expect(detachedBlock).toBeDefined();
  });

  test("location mismatch with content diff: sync both in one pass", async () => {
    const label = `test-location-content-${Date.now()}`;
    const originalContent = "Original content";
    const newContent = "New content at root";

    // Create file in system/
    writeSystemFile(label, originalContent);

    // First sync - creates attached block
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });

    let attachedBlocks = await getAttachedBlocks();
    let block = attachedBlocks.find((b) => b.label === label);
    expect(block).toBeDefined();
    const blockId = block?.id;
    if (blockId) {
      createdBlockIds.push(blockId);
    }

    // Move file to root AND change content
    deleteFile(getSystemDir(), label);
    writeDetachedFile(label, newContent);

    // Second sync - should update content AND detach in one pass
    const result = await syncMemoryFilesystem(testAgentId, {
      homeDir: tempHomeDir,
    });

    // Verify block content was updated
    expect(result.updatedBlocks).toContain(label);

    // Verify block is detached
    attachedBlocks = await getAttachedBlocks();
    block = attachedBlocks.find((b) => b.label === label);
    expect(block).toBeUndefined();

    // Verify detached block has new content
    const ownedBlocks = await getOwnedBlocks();
    const detachedBlock = ownedBlocks.find((b) => b.label === label);
    expect(detachedBlock).toBeDefined();
    expect(detachedBlock?.value).toBe(newContent);
  });

  test("checkMemoryFilesystemStatus reports location mismatches", async () => {
    const label = `test-status-${Date.now()}`;
    const content = "Status test content";

    // Create file in system/
    writeSystemFile(label, content);

    // First sync - creates attached block
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });

    const attachedBlocks = await getAttachedBlocks();
    const block = attachedBlocks.find((b) => b.label === label);
    if (block?.id) {
      createdBlockIds.push(block.id);
    }

    // Move file to root (content unchanged)
    deleteFile(getSystemDir(), label);
    writeDetachedFile(label, content);

    // Check status - should report location mismatch
    const status = await checkMemoryFilesystemStatus(testAgentId, {
      homeDir: tempHomeDir,
    });

    expect(status.locationMismatches).toContain(label);
    expect(status.isClean).toBe(false);
  });

  // =========================================================================
  // Read-only block tests
  // =========================================================================

  test("read_only block: file edit is overwritten by API content", async () => {
    const label = `test-readonly-${Date.now()}`;
    const originalContent = "Original read-only content";
    const editedContent = "User tried to edit this";

    // Create a read_only block via API
    const block = await client.blocks.create({
      label,
      value: originalContent,
      description: "Test read-only block",
      read_only: true,
      tags: [`owner:${testAgentId}`],
    });
    createdBlockIds.push(block.id);

    // Attach to agent
    await client.agents.blocks.attach(block.id, { agent_id: testAgentId });

    // First sync - creates file
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });

    // Verify file was created
    const filePath = join(getSystemDir(), `${label}.md`);
    expect(existsSync(filePath)).toBe(true);

    // Edit the file locally
    writeFileSync(filePath, editedContent);

    // Second sync - should overwrite with API content
    const result = await syncMemoryFilesystem(testAgentId, {
      homeDir: tempHomeDir,
    });

    // File should be in updatedFiles (overwritten)
    expect(result.updatedFiles).toContain(label);

    // Verify file content is back to original (API wins)
    const fileContent = readFileSync(filePath, "utf-8");
    expect(fileContent).toContain(originalContent);

    // Verify block was NOT updated (still has original content)
    const updatedBlock = await client.blocks.retrieve(block.id);
    expect(updatedBlock.value).toBe(originalContent);
  });

  test("read_only block: deleted file is recreated", async () => {
    const label = `test-readonly-delete-${Date.now()}`;
    const content = "Content that should persist";

    // Create a read_only block via API
    const block = await client.blocks.create({
      label,
      value: content,
      description: "Test read-only block for deletion",
      read_only: true,
      tags: [`owner:${testAgentId}`],
    });
    createdBlockIds.push(block.id);

    // Attach to agent
    await client.agents.blocks.attach(block.id, { agent_id: testAgentId });

    // First sync - creates file
    await syncMemoryFilesystem(testAgentId, { homeDir: tempHomeDir });

    // Verify file was created
    const filePath = join(getSystemDir(), `${label}.md`);
    expect(existsSync(filePath)).toBe(true);

    // Delete the file locally
    rmSync(filePath);
    expect(existsSync(filePath)).toBe(false);

    // Second sync - should recreate file (not remove owner tag)
    const result = await syncMemoryFilesystem(testAgentId, {
      homeDir: tempHomeDir,
    });

    // File should be recreated
    expect(result.createdFiles).toContain(label);
    expect(existsSync(filePath)).toBe(true);

    // Verify block still has owner tag and is attached
    const attachedBlocks = await client.agents.blocks.list(testAgentId);
    const attachedArray = Array.isArray(attachedBlocks)
      ? attachedBlocks
      : (attachedBlocks as { items?: Array<{ id: string }> }).items || [];
    expect(attachedArray.some((b) => b.id === block.id)).toBe(true);
  });

  test("read_only label: file-only (no block) is deleted", async () => {
    // This tests the case where someone creates a file for a read_only label
    // but no corresponding block exists - the file should be deleted
    const label = "skills";

    // Helper to ensure no block exists for this label
    async function ensureNoBlock(labelToDelete: string) {
      // Remove attached blocks with this label
      const attachedBlocks = await getAttachedBlocks();
      for (const b of attachedBlocks.filter((x) => x.label === labelToDelete)) {
        if (b.id) {
          try {
            await client.agents.blocks.detach(b.id, { agent_id: testAgentId });
            await client.blocks.delete(b.id);
          } catch {
            // Ignore errors (block may not be deletable)
          }
        }
      }
      // Remove detached owned blocks with this label
      const ownedBlocks = await getOwnedBlocks();
      for (const b of ownedBlocks.filter((x) => x.label === labelToDelete)) {
        if (b.id) {
          try {
            await client.blocks.delete(b.id);
          } catch {
            // Ignore errors
          }
        }
      }
    }

    // Ensure API has no block for this label
    await ensureNoBlock(label);

    // Verify no block exists
    const attachedBefore = await getAttachedBlocks();
    const ownedBefore = await getOwnedBlocks();
    const blockExists =
      attachedBefore.some((b) => b.label === label) ||
      ownedBefore.some((b) => b.label === label);

    // For fresh test agents, there should be no skills block
    // If one exists and can't be deleted, we can't run this test
    expect(blockExists).toBe(false);
    if (blockExists) {
      // This assertion above will fail, but just in case:
      return;
    }

    // Create local file in system/
    writeSystemFile(label, "local skills content that should be deleted");

    // Verify file was created
    const filePath = join(getSystemDir(), `${label}.md`);
    expect(existsSync(filePath)).toBe(true);

    // Sync - should delete the file (API is authoritative for read_only labels)
    const result = await syncMemoryFilesystem(testAgentId, {
      homeDir: tempHomeDir,
    });

    // File should be deleted
    expect(existsSync(filePath)).toBe(false);
    expect(result.deletedFiles).toContain(label);
  });
});
