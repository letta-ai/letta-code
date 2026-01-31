import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, relative } from "node:path";
import { parseArgs } from "node:util";
import { getClient } from "../../agent/client";
import { parseMdxFrontmatter } from "../../agent/memory";
import { READ_ONLY_BLOCK_LABELS } from "../../agent/memoryConstants";
import {
  ensureMemoryFilesystemDirs,
  syncMemoryFilesystem,
} from "../../agent/memoryFilesystem";

const MEMORY_FS_STATE_FILE = ".sync-state.json";
const MEMFS_MANAGED_LABELS = new Set(["memory_filesystem"]);
const READ_ONLY_LABELS = new Set(READ_ONLY_BLOCK_LABELS as readonly string[]);

type SyncState = {
  blockHashes: Record<string, string>;
  fileHashes: Record<string, string>;
  blockIds: Record<string, string>;
  lastSync: string | null;
};

function printUsage(): void {
  console.log(
    `
Usage:
  letta memfs status [--agent <id>]
  letta memfs diff [--agent <id>]
  letta memfs resolve --resolutions '<JSON>' [--agent <id>]

Notes:
  - Requires agent id via --agent or LETTA_AGENT_ID.
  - Output is JSON only.

Examples:
  LETTA_AGENT_ID=agent-123 letta memfs status
  letta memfs diff --agent agent-123
  letta memfs resolve --agent agent-123 --resolutions '[{"label":"human/prefs","resolution":"file"}]'
`.trim(),
  );
}

function getAgentId(agentFromArgs?: string, agentIdFromArgs?: string): string {
  return agentFromArgs || agentIdFromArgs || process.env.LETTA_AGENT_ID || "";
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashFileBody(content: string): string {
  const { body } = parseMdxFrontmatter(content);
  return hashContent(body);
}

function loadSyncState(agentId: string): SyncState {
  const root = getMemoryRoot(agentId);
  const statePath = join(root, MEMORY_FS_STATE_FILE);
  if (!existsSync(statePath)) {
    return {
      blockHashes: {},
      fileHashes: {},
      blockIds: {},
      lastSync: null,
    };
  }

  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      blockHashes: parsed.blockHashes || {},
      fileHashes: parsed.fileHashes || {},
      blockIds: parsed.blockIds || {},
      lastSync: parsed.lastSync || null,
    };
  } catch {
    return {
      blockHashes: {},
      fileHashes: {},
      blockIds: {},
      lastSync: null,
    };
  }
}

function getMemoryRoot(agentId: string): string {
  return join(homedir(), ".letta", "agents", agentId, "memory");
}

async function scanMdFiles(
  dir: string,
  baseDir = dir,
  excludeDirs: string[] = [],
): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      results.push(...(await scanMdFiles(fullPath, baseDir, excludeDirs)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(relative(baseDir, fullPath));
    }
  }
  return results;
}

function labelFromPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/\.md$/, "");
}

async function readMemoryFiles(
  dir: string,
  excludeDirs: string[] = [],
): Promise<Map<string, { content: string }>> {
  const files = await scanMdFiles(dir, dir, excludeDirs);
  const entries = new Map<string, { content: string }>();
  for (const rel of files) {
    const label = labelFromPath(rel);
    const content = await readFile(join(dir, rel), "utf-8");
    entries.set(label, { content });
  }
  return entries;
}

function getOverflowDirectory(): string {
  const cwd = process.cwd();
  const normalizedPath = normalize(cwd);
  const sanitizedPath = normalizedPath
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "_")
    .replace(/\s+/g, "_");

  return join(homedir(), ".letta", "projects", sanitizedPath, "agent-tools");
}

type Conflict = {
  label: string;
  fileContent: string;
  blockContent: string;
};

type MetadataChange = {
  label: string;
  fileContent: string;
  blockContent: string;
};

async function computeStatus(agentId: string) {
  const client = await getClient();
  const root = getMemoryRoot(agentId);
  const systemDir = join(root, "system");
  const detachedDir = root;

  for (const dir of [root, systemDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const systemFiles = await readMemoryFiles(systemDir);
  const detachedFiles = await readMemoryFiles(detachedDir, ["system", "user"]);

  const blocksResponse = await client.agents.blocks.list(agentId, {
    limit: 1000,
  });
  const attachedBlocks = Array.isArray(blocksResponse)
    ? blocksResponse
    : ((blocksResponse as { items?: unknown[] }).items as Array<{
        id?: string;
        label?: string;
        value?: string;
        read_only?: boolean;
      }>) || [];

  const systemBlockMap = new Map<
    string,
    { value: string; id: string; read_only?: boolean }
  >();
  for (const block of attachedBlocks) {
    if (block.label && block.id) {
      systemBlockMap.set(block.label, {
        value: block.value || "",
        id: block.id,
        read_only: block.read_only,
      });
    }
  }

  const ownedBlocksResponse = await client.blocks.list({
    tags: [`owner:${agentId}`],
    limit: 1000,
  });
  const ownedBlocks = Array.isArray(ownedBlocksResponse)
    ? ownedBlocksResponse
    : ((ownedBlocksResponse as { items?: unknown[] }).items as Array<{
        id?: string;
        label?: string;
        value?: string;
        read_only?: boolean;
      }>) || [];

  const attachedIds = new Set(attachedBlocks.map((b) => b.id));
  const detachedBlockMap = new Map<
    string,
    { value: string; id: string; read_only?: boolean }
  >();
  for (const block of ownedBlocks) {
    if (block.label && block.id && !attachedIds.has(block.id)) {
      if (!systemBlockMap.has(block.label)) {
        detachedBlockMap.set(block.label, {
          value: block.value || "",
          id: block.id,
          read_only: block.read_only,
        });
      }
    }
  }

  const lastState = loadSyncState(agentId);

  const conflicts: Array<{ label: string }> = [];
  const pendingFromFile: string[] = [];
  const pendingFromBlock: string[] = [];
  const newFiles: string[] = [];
  const newBlocks: string[] = [];
  const locationMismatches: string[] = [];

  const allLabels = new Set<string>([
    ...systemFiles.keys(),
    ...detachedFiles.keys(),
    ...systemBlockMap.keys(),
    ...detachedBlockMap.keys(),
    ...Object.keys(lastState.blockHashes),
    ...Object.keys(lastState.fileHashes),
  ]);

  for (const label of [...allLabels].sort()) {
    if (MEMFS_MANAGED_LABELS.has(label)) continue;

    const systemFile = systemFiles.get(label);
    const detachedFile = detachedFiles.get(label);
    const attachedBlock = systemBlockMap.get(label);
    const detachedBlock = detachedBlockMap.get(label);

    const fileEntry = systemFile || detachedFile;
    const fileInSystem = !!systemFile;
    const blockEntry = attachedBlock || detachedBlock;
    const isAttached = !!attachedBlock;
    const effectiveReadOnly =
      !!blockEntry?.read_only || READ_ONLY_LABELS.has(label);

    if (fileEntry && blockEntry) {
      const locationMismatch =
        (fileInSystem && !isAttached) || (!fileInSystem && isAttached);
      if (locationMismatch) locationMismatches.push(label);
    }

    const fileHash = fileEntry ? hashContent(fileEntry.content) : null;
    const fileBodyHash = fileEntry ? hashFileBody(fileEntry.content) : null;
    const blockHash = blockEntry ? hashContent(blockEntry.value) : null;

    const lastFileHash = lastState.fileHashes[label] ?? null;
    const lastBlockHash = lastState.blockHashes[label] ?? null;

    const fileChanged = fileHash !== lastFileHash;
    const blockChanged = blockHash !== lastBlockHash;

    if (fileEntry && !blockEntry) {
      if (READ_ONLY_LABELS.has(label)) continue;
      if (lastBlockHash && !fileChanged) continue;
      newFiles.push(label);
      continue;
    }

    if (!fileEntry && blockEntry) {
      if (effectiveReadOnly) {
        pendingFromFile.push(label);
        continue;
      }
      if (lastFileHash && !blockChanged) continue;
      newBlocks.push(label);
      continue;
    }

    if (!fileEntry || !blockEntry) continue;

    if (effectiveReadOnly) {
      if (blockChanged) pendingFromBlock.push(label);
      continue;
    }

    if (fileBodyHash === blockHash) {
      if (fileChanged) pendingFromFile.push(label);
      continue;
    }

    if (fileChanged) {
      pendingFromFile.push(label);
      continue;
    }

    if (blockChanged) {
      pendingFromBlock.push(label);
    }
  }

  const isClean =
    conflicts.length === 0 &&
    pendingFromFile.length === 0 &&
    pendingFromBlock.length === 0 &&
    newFiles.length === 0 &&
    newBlocks.length === 0 &&
    locationMismatches.length === 0;

  return {
    conflicts,
    pendingFromFile,
    pendingFromBlock,
    newFiles,
    newBlocks,
    locationMismatches,
    isClean,
    lastSync: lastState.lastSync,
  };
}

async function computeDiff(agentId: string): Promise<{
  conflicts: Conflict[];
  metadataOnly: MetadataChange[];
}> {
  const client = await getClient();
  const root = getMemoryRoot(agentId);
  const systemDir = join(root, "system");
  const detachedDir = root;

  for (const dir of [root, systemDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const systemFiles = await readMemoryFiles(systemDir);
  const detachedFiles = await readMemoryFiles(detachedDir, ["system", "user"]);

  const blocksResponse = await client.agents.blocks.list(agentId, {
    limit: 1000,
  });
  const attachedBlocks = Array.isArray(blocksResponse)
    ? blocksResponse
    : ((blocksResponse as { items?: unknown[] }).items as Array<{
        id?: string;
        label?: string;
        value?: string;
        read_only?: boolean;
      }>) || [];

  const systemBlockMap = new Map<
    string,
    { value: string; id: string; read_only?: boolean }
  >();
  for (const block of attachedBlocks) {
    if (block.label && block.id) {
      systemBlockMap.set(block.label, {
        value: block.value || "",
        id: block.id,
        read_only: block.read_only,
      });
    }
  }

  const ownedBlocksResponse = await client.blocks.list({
    tags: [`owner:${agentId}`],
    limit: 1000,
  });
  const ownedBlocks = Array.isArray(ownedBlocksResponse)
    ? ownedBlocksResponse
    : ((ownedBlocksResponse as { items?: unknown[] }).items as Array<{
        id?: string;
        label?: string;
        value?: string;
        read_only?: boolean;
      }>) || [];

  const attachedIds = new Set(attachedBlocks.map((b) => b.id));
  const detachedBlockMap = new Map<
    string,
    { value: string; id: string; read_only?: boolean }
  >();
  for (const block of ownedBlocks) {
    if (block.label && block.id && !attachedIds.has(block.id)) {
      if (!systemBlockMap.has(block.label)) {
        detachedBlockMap.set(block.label, {
          value: block.value || "",
          id: block.id,
          read_only: block.read_only,
        });
      }
    }
  }

  const lastState = loadSyncState(agentId);
  const conflicts: Conflict[] = [];
  const metadataOnly: MetadataChange[] = [];

  const allLabels = new Set<string>([
    ...systemFiles.keys(),
    ...detachedFiles.keys(),
    ...systemBlockMap.keys(),
    ...detachedBlockMap.keys(),
    ...Object.keys(lastState.blockHashes),
    ...Object.keys(lastState.fileHashes),
  ]);

  for (const label of [...allLabels].sort()) {
    if (MEMFS_MANAGED_LABELS.has(label)) continue;

    const systemFile = systemFiles.get(label);
    const detachedFile = detachedFiles.get(label);
    const attachedBlock = systemBlockMap.get(label);
    const detachedBlock = detachedBlockMap.get(label);

    const fileEntry = systemFile || detachedFile;
    const blockEntry = attachedBlock || detachedBlock;

    if (!fileEntry || !blockEntry) continue;

    const effectiveReadOnly =
      !!blockEntry.read_only || READ_ONLY_LABELS.has(label);
    if (effectiveReadOnly) continue;

    const fileHash = hashContent(fileEntry.content);
    const fileBodyHash = hashFileBody(fileEntry.content);
    const blockHash = hashContent(blockEntry.value);

    const lastFileHash = lastState.fileHashes[label] ?? null;
    const lastBlockHash = lastState.blockHashes[label] ?? null;

    const fileChanged = fileHash !== lastFileHash;
    const blockChanged = blockHash !== lastBlockHash;

    if (fileBodyHash === blockHash) {
      if (fileChanged) {
        metadataOnly.push({
          label,
          fileContent: fileEntry.content,
          blockContent: blockEntry.value,
        });
      }
      continue;
    }

    if (fileChanged && blockChanged) {
      conflicts.push({
        label,
        fileContent: fileEntry.content,
        blockContent: blockEntry.value,
      });
    }
  }

  return { conflicts, metadataOnly };
}

function formatDiffFile(
  conflicts: Conflict[],
  metadataOnly: MetadataChange[],
  agentId: string,
): string {
  const lines: string[] = [
    `# Memory Filesystem Diff`,
    ``,
    `Agent: ${agentId}`,
    `Generated: ${new Date().toISOString()}`,
    `Conflicts: ${conflicts.length}`,
    `Metadata-only changes: ${metadataOnly.length}`,
    ``,
    `---`,
    ``,
  ];

  for (const conflict of conflicts) {
    lines.push(`## Conflict: ${conflict.label}`);
    lines.push(``);
    lines.push(`### File Version`);
    lines.push(`\`\`\``);
    lines.push(conflict.fileContent);
    lines.push(`\`\`\``);
    lines.push(``);
    lines.push(`### Block Version`);
    lines.push(`\`\`\``);
    lines.push(conflict.blockContent);
    lines.push(`\`\`\``);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  if (metadataOnly.length > 0) {
    lines.push(`## Metadata-only Changes`);
    lines.push(``);
    lines.push(
      `Frontmatter changed while body content stayed the same (file wins).`,
    );
    lines.push(``);

    for (const change of metadataOnly) {
      lines.push(`### ${change.label}`);
      lines.push(``);
      lines.push(`#### File Version (with frontmatter)`);
      lines.push(`\`\`\``);
      lines.push(change.fileContent);
      lines.push(`\`\`\``);
      lines.push(``);
      lines.push(`#### Block Version (body only)`);
      lines.push(`\`\`\``);
      lines.push(change.blockContent);
      lines.push(`\`\`\``);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }
  }

  return lines.join("\n");
}

export async function runMemfsSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        agent: { type: "string" },
        "agent-id": { type: "string" },
        resolutions: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;

  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }

  const agentId = getAgentId(
    parsed.values.agent as string | undefined,
    parsed.values["agent-id"] as string | undefined,
  );

  if (!agentId) {
    console.error(
      "Missing agent id. Set LETTA_AGENT_ID or pass --agent/--agent-id.",
    );
    return 1;
  }

  ensureMemoryFilesystemDirs(agentId);

  try {
    if (action === "status") {
      const status = await computeStatus(agentId);
      console.log(JSON.stringify(status, null, 2));
      return status.isClean ? 0 : 2;
    }

    if (action === "diff") {
      const { conflicts, metadataOnly } = await computeDiff(agentId);
      if (conflicts.length === 0 && metadataOnly.length === 0) {
        console.log(
          JSON.stringify(
            { conflicts: [], metadataOnly: [], diffPath: null, clean: true },
            null,
            2,
          ),
        );
        return 0;
      }

      const diffContent = formatDiffFile(conflicts, metadataOnly, agentId);
      const overflowDir = getOverflowDirectory();
      if (!existsSync(overflowDir)) {
        mkdirSync(overflowDir, { recursive: true });
      }
      const filename = `memfs-diff-${randomUUID()}.md`;
      const diffPath = join(overflowDir, filename);
      writeFileSync(diffPath, diffContent, "utf-8");

      console.log(
        JSON.stringify(
          { conflicts, metadataOnly, diffPath, clean: false },
          null,
          2,
        ),
      );
      return conflicts.length > 0 ? 2 : 0;
    }

    if (action === "resolve") {
      const resolutionsRaw = parsed.values.resolutions as string | undefined;
      if (!resolutionsRaw) {
        console.error("Missing --resolutions JSON.");
        return 1;
      }

      let resolutions: Array<{ label: string; resolution: "file" | "block" }> =
        [];
      try {
        const parsedResolutions = JSON.parse(resolutionsRaw);
        if (!Array.isArray(parsedResolutions)) {
          throw new Error("resolutions must be an array");
        }
        resolutions = parsedResolutions;
      } catch (error) {
        console.error(
          `Invalid --resolutions JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
      }

      const result = await syncMemoryFilesystem(agentId, {
        resolutions,
      });

      console.log(JSON.stringify(result, null, 2));
      return result.conflicts.length > 0 ? 2 : 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.error(`Unknown action: ${action}`);
  printUsage();
  return 1;
}
