/**
 * Shared memory groups — cross-agent memory sharing.
 *
 * Allows multiple agents (e.g. agents attached to different notebooks)
 * to share memory blocks via named groups.
 *
 * Layout:
 *   ~/.letta/groups/{groupName}/
 *     ├── shared_memory.json   — shared memory blocks
 *     └── members.json         — list of agent IDs in the group
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { debugLog } from "../utils/debug.js";

const LETTA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".letta",
);
const GROUPS_DIR = path.join(LETTA_DIR, "groups");

interface MemoryBlock {
  label: string;
  value: string;
  updated_at: string;
  updated_by: string;
}

interface SharedMemoryStore {
  blocks: MemoryBlock[];
}

// ── Path helpers ──────────────────────────────────────────────

function getGroupDir(groupName: string): string {
  return path.join(GROUPS_DIR, groupName);
}

function getSharedMemoryPath(groupName: string): string {
  return path.join(getGroupDir(groupName), "shared_memory.json");
}

function getMembersPath(groupName: string): string {
  return path.join(getGroupDir(groupName), "members.json");
}

async function ensureGroupDir(groupName: string): Promise<void> {
  await fs.mkdir(getGroupDir(groupName), { recursive: true });
}

// ── Members management ────────────────────────────────────────

export async function joinGroup(
  agentId: string,
  groupName: string,
): Promise<string[]> {
  await ensureGroupDir(groupName);
  const membersPath = getMembersPath(groupName);

  let members: string[] = [];
  try {
    const data = await fs.readFile(membersPath, "utf-8");
    members = JSON.parse(data);
  } catch {
    // File doesn't exist yet
  }

  if (!members.includes(agentId)) {
    members.push(agentId);
    await fs.writeFile(membersPath, JSON.stringify(members, null, 2), "utf-8");
  }

  // Initialize shared memory if it doesn't exist
  const sharedPath = getSharedMemoryPath(groupName);
  try {
    await fs.access(sharedPath);
  } catch {
    const initial: SharedMemoryStore = {
      blocks: [
        {
          label: "project_context",
          value: "(No shared project context yet.)",
          updated_at: new Date().toISOString(),
          updated_by: agentId,
        },
        {
          label: "shared_knowledge",
          value: "(No shared knowledge yet.)",
          updated_at: new Date().toISOString(),
          updated_by: agentId,
        },
      ],
    };
    await fs.writeFile(sharedPath, JSON.stringify(initial, null, 2), "utf-8");
  }

  debugLog(
    "shared-memory",
    "Agent %s joined group %s (%d members)",
    agentId,
    groupName,
    members.length,
  );
  return members;
}

export async function leaveGroup(
  agentId: string,
  groupName: string,
): Promise<void> {
  const membersPath = getMembersPath(groupName);
  try {
    const data = await fs.readFile(membersPath, "utf-8");
    let members: string[] = JSON.parse(data);
    members = members.filter((m) => m !== agentId);
    await fs.writeFile(membersPath, JSON.stringify(members, null, 2), "utf-8");
  } catch {
    // Group doesn't exist
  }
}

export async function listGroupMembers(
  groupName: string,
): Promise<string[]> {
  const membersPath = getMembersPath(groupName);
  try {
    const data = await fs.readFile(membersPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function listAllGroups(): Promise<string[]> {
  try {
    const entries = await fs.readdir(GROUPS_DIR);
    const groups: string[] = [];
    for (const entry of entries) {
      const membersPath = path.join(GROUPS_DIR, entry, "members.json");
      try {
        await fs.access(membersPath);
        groups.push(entry);
      } catch {
        // Not a valid group
      }
    }
    return groups;
  } catch {
    return [];
  }
}

export async function getAgentGroups(agentId: string): Promise<string[]> {
  const allGroups = await listAllGroups();
  const agentGroups: string[] = [];
  for (const group of allGroups) {
    const members = await listGroupMembers(group);
    if (members.includes(agentId)) {
      agentGroups.push(group);
    }
  }
  return agentGroups;
}

// ── Shared memory operations ──────────────────────────────────

export async function loadSharedMemory(
  groupName: string,
): Promise<SharedMemoryStore> {
  const sharedPath = getSharedMemoryPath(groupName);
  try {
    const data = await fs.readFile(sharedPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return { blocks: [] };
  }
}

export async function updateSharedMemory(
  groupName: string,
  label: string,
  value: string,
  updatedBy: string,
): Promise<void> {
  const store = await loadSharedMemory(groupName);
  const existing = store.blocks.find((b) => b.label === label);

  if (existing) {
    existing.value = value;
    existing.updated_at = new Date().toISOString();
    existing.updated_by = updatedBy;
  } else {
    store.blocks.push({
      label,
      value,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    });
  }

  const sharedPath = getSharedMemoryPath(groupName);
  await fs.writeFile(sharedPath, JSON.stringify(store, null, 2), "utf-8");
}

export async function renderSharedMemory(
  agentId: string,
): Promise<string> {
  const groups = await getAgentGroups(agentId);
  if (groups.length === 0) return "";

  const sections: string[] = [];
  for (const group of groups) {
    const store = await loadSharedMemory(group);
    const members = await listGroupMembers(group);
    const blockTexts = store.blocks.map(
      (b) => `[${b.label}]\n${b.value}`,
    );
    sections.push(
      `## Shared Memory — group: ${group} (${members.length} agent(s))\n${blockTexts.join("\n\n")}`,
    );
  }

  return sections.join("\n\n");
}
