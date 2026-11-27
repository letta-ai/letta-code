import type { TreeNode } from "@/agent/memory-scanner";
import type { MemfsViewerSource } from "@/cli/components/MemfsTreeViewer";
import type { TuiSessionStore } from "./session-store";

interface MemoryEntry {
  relative_path: string;
  content: string;
}

interface Branch {
  dirs: Map<string, Branch>;
  files: string[];
}

function insert(root: Branch, segments: string[]): void {
  let branch = root;
  for (const segment of segments.slice(0, -1)) {
    let next = branch.dirs.get(segment);
    if (!next) {
      next = { dirs: new Map(), files: [] };
      branch.dirs.set(segment, next);
    }
    branch = next;
  }
  const file = segments.at(-1);
  if (file) branch.files.push(file);
}

function flatten(
  branch: Branch,
  prefix: string,
  depth: number,
  parentIsLast: boolean[],
  nodes: TreeNode[],
): void {
  const dirs = [...branch.dirs.keys()].sort();
  const files = [...branch.files].sort();
  const total = dirs.length + files.length;
  let index = 0;
  for (const name of dirs) {
    index += 1;
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const isLast = index === total;
    nodes.push({
      name,
      relativePath,
      fullPath: relativePath,
      isDirectory: true,
      depth,
      isLast,
      parentIsLast,
    });
    const child = branch.dirs.get(name);
    if (child) {
      flatten(child, relativePath, depth + 1, [...parentIsLast, isLast], nodes);
    }
  }
  for (const name of files) {
    index += 1;
    const relativePath = prefix ? `${prefix}/${name}` : name;
    nodes.push({
      name,
      relativePath,
      fullPath: relativePath,
      isDirectory: false,
      depth,
      isLast: index === total,
      parentIsLast,
    });
  }
}

export function buildMemorySource(entries: MemoryEntry[]): MemfsViewerSource {
  const root: Branch = { dirs: new Map(), files: [] };
  const contents: Record<string, string> = {};
  for (const entry of entries) {
    const segments = entry.relative_path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    insert(root, segments);
    contents[segments.join("/")] = entry.content;
  }
  const nodes: TreeNode[] = [];
  flatten(root, "", 0, [], nodes);
  return { nodes, contents };
}

export async function loadMemorySource(
  store: TuiSessionStore,
  agentId: string,
): Promise<MemfsViewerSource | null> {
  const entries: MemoryEntry[] = [];
  const last = await store.request<{
    success: boolean;
    error?: string;
    memfs_enabled?: boolean;
  }>({ type: "list_memory", agent_id: agentId }, "list_memory_response", {
    scoped: false,
    until: (message) => {
      if (Array.isArray(message.entries)) {
        entries.push(...(message.entries as MemoryEntry[]));
      }
      return message.done === true;
    },
  });
  if (!last.success) throw new Error(last.error ?? "Unable to list memory");
  if (last.memfs_enabled === false) return null;
  return buildMemorySource(entries);
}
