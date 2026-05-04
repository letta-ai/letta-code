import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { parseFrontmatter } from "../../utils/frontmatter";
import type { LocalAgentRecord } from "./LocalStore";

const CORE_MEMORY_VARIABLE = "{CORE_MEMORY}";
const MEMORY_DIR_PLACEHOLDER = "$" + "{MEMORY_DIR}";

interface LocalMemoryFile {
  relativePath: string;
  label: string;
  value: string;
  description: string;
}

export interface LocalCompiledSystemPrompt {
  content: string;
  compiledAt: string;
  rawSystemHash: string;
  memfsRevision?: string;
}

export interface CompileLocalSystemPromptOptions {
  agent: LocalAgentRecord;
  conversationId: string;
  memoryDir?: string;
  now?: Date;
  previousMessageCount?: number;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashRawSystemPrompt(systemPrompt: string): string {
  return hashString(systemPrompt);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function labelFromPath(relativePath: string): string {
  return normalizePath(relativePath).replace(/\.md$/, "");
}

function collectMemoryFiles(memoryDir: string): LocalMemoryFile[] {
  const files: LocalMemoryFile[] = [];

  const walk = (currentDir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(currentDir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!stat.isFile() || !entry.endsWith(".md")) continue;

      try {
        const raw = readFileSync(fullPath, "utf8");
        const { frontmatter, body } = parseFrontmatter(raw);
        const relativePath = normalizePath(relative(memoryDir, fullPath));
        files.push({
          relativePath,
          label: labelFromPath(relativePath),
          value: body,
          description:
            typeof frontmatter.description === "string"
              ? frontmatter.description.trim()
              : "",
        });
      } catch {
        // Skip unreadable files. MemFS tooling surfaces read/write errors at
        // the tool boundary; prompt compilation should stay best-effort.
      }
    }
  };

  if (existsSync(memoryDir)) {
    walk(memoryDir);
  }
  return files.sort((a, b) => a.label.localeCompare(b.label));
}

function computeMemfsRevision(files: LocalMemoryFile[]): string {
  return hashString(
    files
      .map((file) =>
        [file.relativePath, file.description, file.value].join("\0"),
      )
      .join("\0\0"),
  );
}

function renderExternalProjection(files: LocalMemoryFile[]): string {
  interface TreeNode extends Map<string, TreeNode | null> {}
  const root: TreeNode = new Map();

  for (const file of files) {
    const parts = file.relativePath.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const existing = node.get(part);
      if (existing instanceof Map) {
        node = existing;
      } else {
        const child: TreeNode = new Map();
        node.set(part, child);
        node = child;
      }
    }
    const leaf = parts.at(-1);
    if (leaf) node.set(leaf, null);
  }

  const lines = ["<external_projection>", `${MEMORY_DIR_PLACEHOLDER}/`];
  const render = (node: TreeNode, prefix = "") => {
    const entries = [...node.entries()].sort(
      ([aName, aNode], [bName, bNode]) => {
        const aDir = aNode instanceof Map;
        const bDir = bNode instanceof Map;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return aName.localeCompare(bName);
      },
    );

    for (const [index, [name, child]] of entries.entries()) {
      const isLast = index === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const isDir = child instanceof Map;
      lines.push(`${prefix}${connector}${name}${isDir ? "/" : ""}`);
      if (isDir) {
        render(child, `${prefix}${isLast ? "    " : "│   "}`);
      }
    }
  };
  render(root);
  lines.push("</external_projection>");
  return lines.join("\n");
}

function renderSystemTree(files: LocalMemoryFile[]): string {
  const LEAF_VALUE = "__value__";
  const LEAF_DESCRIPTION = "__description__";
  interface TreeNode {
    [key: string]: TreeNode | string;
  }
  const tree: TreeNode = {};

  for (const file of files) {
    const label = file.label.replace(/^system\//, "");
    const parts = label.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = tree;
    for (const part of parts) {
      const existing = node[part];
      if (!existing || typeof existing === "string") {
        node[part] = {};
      }
      node = node[part] as TreeNode;
    }
    node[LEAF_VALUE] = file.value;
    node[LEAF_DESCRIPTION] = file.description;
  }

  const lines: string[] = [];
  const render = (node: TreeNode, indent = 0, pathParts: string[] = []) => {
    const pad = "  ".repeat(indent);
    const keys = Object.keys(node)
      .filter((key) => key !== LEAF_VALUE && key !== LEAF_DESCRIPTION)
      .sort((a, b) => a.localeCompare(b));

    for (const key of keys) {
      const child = node[key] as TreeNode;
      const childParts = [...pathParts, key];
      lines.push(`${pad}<${key}>`);
      if (Object.hasOwn(child, LEAF_VALUE)) {
        lines.push(
          `${pad}  <projection>$MEMORY_DIR/system/${childParts.join("/")}.md</projection>`,
        );
        const description = String(child[LEAF_DESCRIPTION] ?? "").trim();
        if (description) {
          lines.push(`${pad}  <description>${description}</description>`);
        }
        const value = String(child[LEAF_VALUE] ?? "").trimEnd();
        if (value) {
          lines.push(`${pad}  ${value}`);
        }
      }
      render(child, indent + 1, childParts);
      lines.push(`${pad}</${key}>`);
    }
  };
  render(tree);
  return lines.join("\n");
}

function renderMemfsProjection(memoryDir: string): {
  content: string;
  revision: string;
} {
  const files = collectMemoryFiles(memoryDir);
  const revision = computeMemfsRevision(files);
  if (files.length === 0) return { content: "", revision };

  const lines = [
    "Reminder: <projection> contains the local path of the memory file projection.",
  ];

  const persona = files.find((file) => file.label === "system/persona");
  if (persona) {
    lines.push(
      "",
      "<self>",
      "<projection>$MEMORY_DIR/system/persona.md</projection>",
      persona.value.trimEnd(),
      "</self>",
    );
  }

  const systemFiles = files.filter(
    (file) =>
      file.label.startsWith("system/") && file.label !== "system/persona",
  );
  const externalFiles = files.filter(
    (file) =>
      !file.label.startsWith("system/") && !file.label.startsWith("skills/"),
  );

  if (systemFiles.length > 0 || externalFiles.length > 0) {
    lines.push("", "<memory>");
    const systemTree = renderSystemTree(systemFiles);
    if (systemTree) lines.push(systemTree);
    if (externalFiles.length > 0) {
      lines.push(renderExternalProjection(externalFiles));
    }
    lines.push("</memory>");
  }

  return { content: lines.join("\n"), revision };
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatUtcTimestamp(date: Date): string {
  const hours = date.getUTCHours();
  const hour12 = hours % 12 || 12;
  const meridiem = hours < 12 ? "AM" : "PM";
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(hour12)}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())} ${meridiem} UTC+0000`;
}

function compileMemoryMetadata(input: {
  agentId: string;
  conversationId: string;
  compiledAt: Date;
  previousMessageCount: number;
}): string {
  return [
    "<memory_metadata>",
    `- AGENT_ID: ${input.agentId}`,
    `- CONVERSATION_ID: ${input.conversationId}`,
    `- System prompt last recompiled: ${formatUtcTimestamp(input.compiledAt)}`,
    `- ${input.previousMessageCount} previous messages between you and the user are stored in recall memory`,
    "</memory_metadata>",
  ].join("\n");
}

function injectCoreMemory(rawSystemPrompt: string, coreMemory: string): string {
  const prompt = rawSystemPrompt.includes(CORE_MEMORY_VARIABLE)
    ? rawSystemPrompt
    : `${rawSystemPrompt.trimEnd()}\n\n${CORE_MEMORY_VARIABLE}`;
  return prompt.replaceAll(CORE_MEMORY_VARIABLE, coreMemory);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function skillRootAndRelativePath(
  name: string,
  location: string,
): {
  root: string;
  relativePath: string;
} {
  const normalized = normalizePath(location.trim());
  if (normalized.endsWith("/SKILL.md")) {
    const skillDir = dirname(normalized);
    const root = dirname(skillDir);
    const relativePath = normalizePath(relative(root, normalized));
    if (basename(skillDir) === name.split("/").at(-1)) {
      return { root: normalizePath(root), relativePath };
    }
  }
  return {
    root: normalizePath(dirname(normalized)),
    relativePath: basename(normalized),
  };
}

export function compileAvailableSkillsBlock(
  clientSkills: unknown[] = [],
): string {
  const seen = new Set<string>();
  const entries: Array<{
    root: string;
    relativePath: string;
    description: string;
  }> = [];

  for (const skill of clientSkills) {
    if (!skill || typeof skill !== "object") continue;
    const record = skill as Record<string, unknown>;
    const name = stringField(record.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description =
      stringField(record.description)?.trim().split("\n")[0] ?? "";
    const location =
      stringField(record.location)?.trim() ||
      `${MEMORY_DIR_PLACEHOLDER}/skills/${name}/SKILL.md`;
    entries.push({
      ...skillRootAndRelativePath(name, location),
      description,
    });
  }

  if (entries.length === 0) return "";

  const grouped = new Map<
    string,
    Array<{ relativePath: string; description: string }>
  >();
  for (const entry of entries) {
    const group = grouped.get(entry.root) ?? [];
    group.push({
      relativePath: entry.relativePath,
      description: entry.description,
    });
    grouped.set(entry.root, group);
  }

  const lines = ["<available_skills>"];
  const roots = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  for (const [rootIndex, root] of roots.entries()) {
    lines.push(root);
    type Tree = Map<string, Tree | string>;
    const tree: Tree = new Map();
    for (const entry of (grouped.get(root) ?? []).sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    )) {
      const parts = entry.relativePath.split("/").filter(Boolean);
      let node = tree;
      for (const part of parts.slice(0, -1)) {
        const existing = node.get(part);
        if (existing instanceof Map) {
          node = existing;
        } else {
          const child: Tree = new Map();
          node.set(part, child);
          node = child;
        }
      }
      const leaf = parts.at(-1);
      if (leaf) node.set(leaf, entry.description);
    }

    const render = (node: Tree, prefix = "") => {
      const entries = [...node.entries()].sort(
        ([aName, aValue], [bName, bValue]) => {
          const aDir = aValue instanceof Map;
          const bDir = bValue instanceof Map;
          if (aDir !== bDir) return aDir ? -1 : 1;
          return aName.localeCompare(bName);
        },
      );
      for (const [index, [name, value]] of entries.entries()) {
        const isLast = index === entries.length - 1;
        const connector = isLast ? "└── " : "├── ";
        if (value instanceof Map) {
          lines.push(`${prefix}${connector}${name}/`);
          render(value, `${prefix}${isLast ? "    " : "│   "}`);
        } else {
          const suffix = value.trim() ? ` (${value.trim()})` : "";
          lines.push(`${prefix}${connector}${name}${suffix}`);
        }
      }
    };
    render(tree);
    if (rootIndex !== roots.length - 1) lines.push("");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function appendAvailableSkillsBlock(
  systemPrompt: string,
  clientSkills: unknown[] = [],
): string {
  const skillsBlock = compileAvailableSkillsBlock(clientSkills);
  if (!skillsBlock) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${skillsBlock.trimStart()}`;
}

export function compileLocalSystemPrompt(
  options: CompileLocalSystemPromptOptions,
): LocalCompiledSystemPrompt {
  const compiledAt = options.now ?? new Date();
  const memoryDir =
    options.memoryDir ?? getMemoryFilesystemRoot(options.agent.id);
  const memfs = renderMemfsProjection(memoryDir);
  const metadata = compileMemoryMetadata({
    agentId: options.agent.id,
    conversationId: options.conversationId,
    compiledAt,
    previousMessageCount: options.previousMessageCount ?? 0,
  });
  const coreMemory = [memfs.content, metadata]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return {
    content: injectCoreMemory(options.agent.system, coreMemory),
    compiledAt: compiledAt.toISOString(),
    rawSystemHash: hashRawSystemPrompt(options.agent.system),
    memfsRevision: memfs.revision,
  };
}
