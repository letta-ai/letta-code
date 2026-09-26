import { DEFAULT_ROOT_MEMORY_BLOCK } from "@/agent/create-agent-request";
import type { AgentCreateBody } from "@/backend/backend";

export interface InitialLocalMemoryFile {
  relativePath: string;
  content: string;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\\/g, "/").replace(/\.md$/, "");
}

function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function legacyMemoryBlockPath(label: string): string {
  const normalized = normalizeLabel(label);
  if (normalized === "system" || normalized.startsWith("system/")) {
    return `${normalized}.md`;
  }
  return `system/${normalized}.md`;
}

function rootMemoryBlockPath(label: string): string {
  const normalized = normalizeLabel(label).replace(/^system\//, "");
  return `${normalized.replaceAll("/", "_")}.md`;
}

function memoryNameFromPath(relativePath: string): string {
  return relativePath
    .replace(/\.md$/, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

function validRelativePath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  return (
    relativePath !== ".md" &&
    !relativePath.startsWith("/") &&
    segments.length > 0 &&
    !segments.some((segment) => segment === "." || segment === "..")
  );
}

function renderInitialMemoryFile(input: {
  label: string;
  value: string;
  description?: string | null;
  rootLayout: boolean;
}): InitialLocalMemoryFile | null {
  if (input.rootLayout && input.label === DEFAULT_ROOT_MEMORY_BLOCK.label) {
    return { relativePath: "MEMORY.md", content: input.value };
  }

  const relativePath = input.rootLayout
    ? rootMemoryBlockPath(input.label)
    : legacyMemoryBlockPath(input.label);
  if (!validRelativePath(relativePath)) return null;
  const description =
    typeof input.description === "string" && input.description.trim()
      ? sanitizeFrontmatterValue(input.description)
      : `Memory block ${input.label}`;
  const frontmatter = input.rootLayout
    ? [
        "---",
        `name: ${memoryNameFromPath(relativePath)}`,
        `description: ${description}`,
        "---",
      ]
    : ["---", `description: ${description}`, "---"];
  return {
    relativePath,
    content: [...frontmatter, input.value].join("\n"),
  };
}

function memoryBlocks(body: AgentCreateBody): Array<Record<string, unknown>> {
  const value = (body as Record<string, unknown>).memory_blocks;
  return Array.isArray(value)
    ? value.filter(
        (block): block is Record<string, unknown> =>
          Boolean(block) && typeof block === "object",
      )
    : [];
}

export function initialMemoryFilesFromCreateBody(
  body: AgentCreateBody,
): InitialLocalMemoryFile[] {
  const blocks = memoryBlocks(body);
  const rootLayout = blocks.some(
    (block) => block.label === DEFAULT_ROOT_MEMORY_BLOCK.label,
  );
  const files = new Map<string, InitialLocalMemoryFile>();

  for (const block of blocks) {
    if (typeof block.label !== "string") continue;
    const file = renderInitialMemoryFile({
      label: block.label,
      value: typeof block.value === "string" ? block.value : "",
      description:
        typeof block.description === "string" ? block.description : null,
      rootLayout,
    });
    if (!file) continue;
    const collision = [...files.keys()].find(
      (path) =>
        path.toLocaleLowerCase("en-US") ===
        file.relativePath.toLocaleLowerCase("en-US"),
    );
    if (collision) {
      throw new Error(`Initial memory path collision at ${file.relativePath}`);
    }
    files.set(file.relativePath, file);
  }

  return [...files.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}
