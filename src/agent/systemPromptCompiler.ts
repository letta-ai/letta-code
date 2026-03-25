/**
 * Client-side system prompt compiler.
 *
 * Replicates the server's `compile_system_message` + `_render_memory_blocks_git`
 * logic so letta-code can build the full system prompt locally and pass it via
 * `override_system` on each message create request.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryBlock {
  /** Slash-separated label derived from relative path, e.g. "system/persona" */
  label: string;
  /** Parsed body content (without frontmatter) */
  value: string;
  /** Frontmatter `description` field */
  description: string;
}

export interface ClientSkillEntry {
  name: string;
  description: string;
  location: string;
}

export interface CompileSystemPromptOptions {
  /** Raw base template (e.g. letta.md + memfs addon) */
  basePrompt: string;
  /** Absolute path to the git-backed memory dir */
  memoryDir: string;
  agentId: string;
  conversationId: string;
  previousMessageCount: number;
  clientSkills?: ClientSkillEntry[];
}

// ---------------------------------------------------------------------------
// Block scanner
// ---------------------------------------------------------------------------

/**
 * Recursively scan the memory directory and return a flat list of blocks.
 * Each `.md` file becomes a block with label = relative path minus `.md`.
 */
export function scanMemoryBlocks(memoryDir: string): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const fullPath = join(dir, name);
      let stat: ReturnType<typeof statSync> | undefined;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (name.endsWith(".md")) {
        const rel = relative(memoryDir, fullPath);
        const label = rel.replace(/\.md$/, "").replace(/\\/g, "/");
        let raw: string;
        try {
          raw = readFileSync(fullPath, "utf-8");
        } catch {
          continue;
        }
        const { frontmatter, body } = parseFrontmatter(raw);
        const description =
          typeof frontmatter.description === "string"
            ? frontmatter.description
            : "";
        blocks.push({ label, value: body, description });
      }
    }
  }

  walk(memoryDir);
  return blocks;
}

// ---------------------------------------------------------------------------
// Renderers — match server's _render_memory_blocks_git output exactly
// ---------------------------------------------------------------------------

const LEAF_KEY = "__value__";
const LEAF_DESC_KEY = "__description__";
const LEAF_LABEL_KEY = "__label__";

function buildTree(
  blocks: MemoryBlock[],
  stripPrefix?: string,
): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const block of blocks) {
    let label = block.label;
    if (stripPrefix) {
      if (!label.startsWith(stripPrefix)) continue;
      label = label.slice(stripPrefix.length);
    }
    const parts = label.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let node = tree as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      if (
        !(part in node) ||
        typeof node[part] !== "object" ||
        node[part] === null
      ) {
        node[part] = {};
      }
      node = node[part] as Record<string, unknown>;
    }

    const leaf = parts[parts.length - 1]!;
    const leafNode = node[leaf];
    const desc = (block.description || "").trim();
    if (leafNode == null) {
      node[leaf] = {
        [LEAF_KEY]: block.value || "",
        [LEAF_DESC_KEY]: desc,
        [LEAF_LABEL_KEY]: block.label,
      };
    } else if (typeof leafNode === "object") {
      (leafNode as Record<string, unknown>)[LEAF_KEY] = block.value || "";
      (leafNode as Record<string, unknown>)[LEAF_DESC_KEY] = desc;
      (leafNode as Record<string, unknown>)[LEAF_LABEL_KEY] = block.label;
    } else {
      node[leaf] = {
        [LEAF_KEY]: block.value || "",
        [LEAF_DESC_KEY]: desc,
        [LEAF_LABEL_KEY]: block.label,
      };
    }
  }
  return tree;
}

function renderNestedTree(
  node: Record<string, unknown>,
  lines: string[],
  indent = 0,
  pathParts: string[] = [],
): void {
  const pad = "  ".repeat(indent);
  const keys = Object.keys(node)
    .filter(
      (k) => k !== LEAF_KEY && k !== LEAF_DESC_KEY && k !== LEAF_LABEL_KEY,
    )
    .sort();

  for (const key of keys) {
    const child = node[key];
    const childParts = [...pathParts, key];
    lines.push(`${pad}<${key}>`);

    if (typeof child === "object" && child !== null) {
      const childObj = child as Record<string, unknown>;
      if (LEAF_KEY in childObj) {
        const projectionPath = childParts.join("/");
        lines.push(
          `${pad}  <projection>$MEMORY_DIR/system/${projectionPath}.md</projection>`,
        );
      }
      const desc = String(childObj[LEAF_DESC_KEY] ?? "").trimEnd();
      if (desc) {
        lines.push(`${pad}  <description>${desc}</description>`);
      }
      if (LEAF_KEY in childObj) {
        const value = String(childObj[LEAF_KEY] ?? "").trimEnd();
        if (value) {
          lines.push(`${pad}  ${value}`);
        }
      }
      renderNestedTree(childObj, lines, indent + 1, childParts);
    }
    lines.push(`${pad}</${key}>`);
  }
}

/** Render <self> from system/persona block. */
export function renderSelfSection(blocks: MemoryBlock[]): string {
  const persona = blocks.find((b) => b.label === "system/persona");
  if (!persona) return "";
  const lines: string[] = [];
  lines.push("\n<self>");
  lines.push("<projection>$MEMORY_DIR/system/persona.md</projection>");
  lines.push((persona.value || "").trimEnd());
  lines.push("</self>");
  return lines.join("\n");
}

/** Render <memory> section with nested XML + external projection tree. */
export function renderMemorySection(blocks: MemoryBlock[]): string {
  const systemBlocks = blocks.filter((b) => b.label.startsWith("system/"));
  const nonPersona = systemBlocks.filter((b) => b.label !== "system/persona");
  const externalBlocks = blocks.filter(
    (b) => !b.label.startsWith("system/") && !b.label.startsWith("skills/"),
  );

  if (nonPersona.length === 0 && externalBlocks.length === 0) return "";

  const systemTree = buildTree(nonPersona, "system/");
  const lines: string[] = [];
  lines.push("\n<memory>");
  renderNestedTree(systemTree, lines);

  // External projection tree
  if (externalBlocks.length > 0) {
    lines.push("<external_projection>");

    // Build file tree structure
    const tree: Record<string, unknown> = {};
    const sortedExternal = [...externalBlocks].sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    for (const block of sortedExternal) {
      const label = block.label.trim();
      if (!label) continue;
      const parts = label.split("/").filter(Boolean);
      if (parts.length === 0) continue;

      let node = tree as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) {
        if (!(part in node) || typeof node[part] !== "object") {
          node[part] = {};
        }
        node = node[part] as Record<string, unknown>;
      }
      node[`${parts[parts.length - 1]!}.md`] = null;
    }

    lines.push("${MEMORY_DIR}/");
    renderExternalTree(tree, lines, "");
    lines.push("</external_projection>");
  }

  lines.push("</memory>");
  return lines.join("\n");
}

function renderExternalTree(
  node: Record<string, unknown>,
  lines: string[],
  prefix: string,
): void {
  const dirs = Object.keys(node)
    .filter((k) => typeof node[k] === "object" && node[k] !== null)
    .sort();
  const files = Object.keys(node)
    .filter((k) => node[k] === null)
    .sort();
  const entries: Array<[string, boolean]> = [
    ...dirs.map((d) => [d, true] as [string, boolean]),
    ...files.map((f) => [f, false] as [string, boolean]),
  ];

  for (let i = 0; i < entries.length; i++) {
    const [name, isDir] = entries[i]!;
    const isLast = i === entries.length - 1;
    const connector = isLast ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ";
    if (isDir) {
      lines.push(`${prefix}${connector}${name}/`);
      const extension = isLast ? "    " : "\u2502   ";
      renderExternalTree(
        node[name] as Record<string, unknown>,
        lines,
        prefix + extension,
      );
    } else {
      lines.push(`${prefix}${connector}${name}`);
    }
  }
}

/** Render <available_skills> from skills blocks + client skills. */
export function renderAvailableSkills(
  blocks: MemoryBlock[],
  clientSkills?: ClientSkillEntry[],
): string {
  const allEntries: Array<{
    name: string;
    description: string;
    location: string;
  }> = [];
  const seen = new Set<string>();

  // Agent-scoped skills from skills/* blocks
  for (const block of blocks) {
    if (!block.label.startsWith("skills/")) continue;
    const parts = block.label.split("/");
    if (parts.length < 2) continue;
    const skillName = parts[1]!;
    const isTopLevel =
      parts.length === 2 || (parts.length === 3 && parts[2] === "SKILL");
    if (!isTopLevel || seen.has(skillName)) continue;
    seen.add(skillName);
    const desc = (block.description || "").trim().split("\n")[0]!.trim();
    const location = `\${MEMORY_DIR}/skills/${skillName}/SKILL.md`;
    allEntries.push({ name: skillName, description: desc, location });
  }

  // Client-provided skills
  if (clientSkills) {
    for (const cs of clientSkills) {
      if (seen.has(cs.name)) continue;
      seen.add(cs.name);
      const desc = (cs.description || "").trim().split("\n")[0]!.trim();
      const location =
        (cs.location || "").trim() ||
        `\${MEMORY_DIR}/skills/${cs.name}/SKILL.md`;
      allEntries.push({ name: cs.name, description: desc, location });
    }
  }

  if (allEntries.length === 0) return "";

  // Group by root path
  function skillRoot(
    skillName: string,
    location: string,
  ): { root: string; relPath: string } {
    const norm = location.trim();
    if (norm.endsWith("/SKILL.md")) {
      const skillDir = norm.slice(0, norm.lastIndexOf("/"));
      const root = skillDir.slice(0, skillDir.lastIndexOf("/"));
      const dirBasename = skillDir.slice(skillDir.lastIndexOf("/") + 1);
      const nameBasename = skillName.split("/").pop() ?? skillName;
      if (dirBasename === nameBasename) {
        const rel = norm.slice(root.length + 1);
        return { root, relPath: rel };
      }
    }
    const root = norm.slice(0, norm.lastIndexOf("/"));
    const rel = norm.slice(norm.lastIndexOf("/") + 1);
    return { root, relPath: rel };
  }

  const grouped = new Map<string, Array<{ relPath: string; desc: string }>>();
  for (const entry of allEntries) {
    const { root, relPath } = skillRoot(entry.name, entry.location);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root)!.push({ relPath, desc: entry.description });
  }

  const lines: string[] = [];
  lines.push("\n<available_skills>");

  const rootPaths = [...grouped.keys()].sort();
  for (let ri = 0; ri < rootPaths.length; ri++) {
    const root = rootPaths[ri]!;
    lines.push(root);

    // Build tree for this root
    const tree: Record<string, unknown> = {};
    const entries = [...grouped.get(root)!].sort((a, b) =>
      a.relPath.localeCompare(b.relPath),
    );
    for (const { relPath, desc } of entries) {
      const parts = relPath.split("/").filter(Boolean);
      if (parts.length === 0) continue;
      let node = tree as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) {
        if (!(part in node) || typeof node[part] !== "object") {
          node[part] = {};
        }
        node = node[part] as Record<string, unknown>;
      }
      node[parts[parts.length - 1]!] = desc;
    }

    renderSkillTree(tree, lines, "");
    if (ri !== rootPaths.length - 1) {
      lines.push("");
    }
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

function renderSkillTree(
  node: Record<string, unknown>,
  lines: string[],
  prefix: string,
): void {
  const dirs = Object.keys(node)
    .filter((k) => typeof node[k] === "object" && node[k] !== null)
    .sort();
  const files = Object.keys(node)
    .filter((k) => typeof node[k] === "string")
    .sort();
  const entries: Array<[string, boolean]> = [
    ...dirs.map((d) => [d, true] as [string, boolean]),
    ...files.map((f) => [f, false] as [string, boolean]),
  ];

  for (let i = 0; i < entries.length; i++) {
    const [name, isDir] = entries[i]!;
    const isLast = i === entries.length - 1;
    const connector = isLast ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ";
    if (isDir) {
      lines.push(`${prefix}${connector}${name}/`);
      const extension = isLast ? "    " : "\u2502   ";
      renderSkillTree(
        node[name] as Record<string, unknown>,
        lines,
        prefix + extension,
      );
    } else {
      const desc = ((node[name] as string) || "").trim();
      const descSuffix = desc ? ` (${desc})` : "";
      lines.push(`${prefix}${connector}${name}${descSuffix}`);
    }
  }
}

/** Render <memory_metadata> block. */
export function renderMemoryMetadata(opts: {
  agentId: string;
  conversationId: string;
  previousMessageCount: number;
}): string {
  const now = new Date();
  const timestampStr = formatTimestamp(now);
  const lines = [
    "\n<memory_metadata>",
    `- AGENT_ID: ${opts.agentId}`,
    `- CONVERSATION_ID: ${opts.conversationId}`,
    `- System prompt last recompiled: ${timestampStr}`,
    `- ${opts.previousMessageCount} previous messages between you and the user are stored in recall memory`,
    "</memory_metadata>",
  ];
  return lines.join("\n");
}

function formatTimestamp(date: Date): string {
  // Match server format: "2026-03-25 02:56:13 AM UTC+0000"
  const day = String(date.getUTCDate()).padStart(2, "0");
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  let hours = date.getUTCHours();
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const hoursStr = String(hours).padStart(2, "0");
  return `${year}-${month}-${day} ${hoursStr}:${minutes}:${seconds} ${ampm} UTC+0000`;
}

// ---------------------------------------------------------------------------
// Main compiler
// ---------------------------------------------------------------------------

/**
 * Compile a full system prompt from a base template and local memory files.
 *
 * Replicates the server's `compile_system_message` pipeline:
 * 1. Scan memory blocks from the git filesystem
 * 2. Render <self>, <memory>, <available_skills>, <memory_metadata>
 * 3. Inject into the base template via {CORE_MEMORY} replacement or append
 */
export function compileSystemPrompt(opts: CompileSystemPromptOptions): string {
  const blocks = scanMemoryBlocks(opts.memoryDir);

  const parts: string[] = [];

  // Reminder line (matches server output)
  parts.push(
    "\nReminder: <projection> contains the local path of the memory file projection.",
  );

  // <self> section
  parts.push(renderSelfSection(blocks));

  // <memory> section
  parts.push(renderMemorySection(blocks));

  // <available_skills> section
  parts.push(renderAvailableSkills(blocks, opts.clientSkills));

  // <memory_metadata> section
  parts.push(
    renderMemoryMetadata({
      agentId: opts.agentId,
      conversationId: opts.conversationId,
      previousMessageCount: opts.previousMessageCount,
    }),
  );

  const fullMemoryString = parts.filter(Boolean).join("\n");

  // Inject into base prompt: replace {CORE_MEMORY} or append
  const coreMemoryVar = "{CORE_MEMORY}";
  const basePrompt = opts.basePrompt;
  if (basePrompt.includes(coreMemoryVar)) {
    return basePrompt.replace(coreMemoryVar, fullMemoryString);
  }
  // Append if the variable placeholder is not present (matches server behavior)
  return `${basePrompt}\n\n${fullMemoryString}`;
}
