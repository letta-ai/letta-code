import {
  getLocalMemoryFormat,
  type LocalMemoryFormat,
  rootMemoryPathFromLegacyLabel,
} from "@/agent/memory-format";
import type { AgentCreateBody } from "@/backend/backend";

export interface InitialMemoryFile {
  relativePath: string;
  content: string;
}

function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function memoryBlockPath(label: string): string {
  const normalized = label.trim().replace(/\\/g, "/").replace(/\.md$/, "");
  if (normalized === "system" || normalized.startsWith("system/")) {
    return `${normalized}.md`;
  }
  return `system/${normalized}.md`;
}

function renderInitialMemoryFile(input: {
  label: string;
  value: string;
  description?: string | null;
  format: LocalMemoryFormat;
}): InitialMemoryFile | null {
  const relativePath =
    input.format === "memfs-v2"
      ? rootMemoryPathFromLegacyLabel(input.label)
      : memoryBlockPath(input.label);
  const segments = relativePath.split("/").filter(Boolean);
  if (
    relativePath === ".md" ||
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : `Memory block ${input.label}`;
  return {
    relativePath: segments.join("/"),
    content:
      input.format === "memfs-v2"
        ? [
            "---",
            `name: ${JSON.stringify(memoryNameFromPath(relativePath))}`,
            `description: ${JSON.stringify(sanitizeFrontmatterValue(description))}`,
            "---",
            input.value,
          ].join("\n")
        : [
            "---",
            `description: ${sanitizeFrontmatterValue(description)}`,
            "---",
            input.value,
          ].join("\n"),
  };
}

function memoryNameFromPath(relativePath: string): string {
  return relativePath
    .replace(/\.md$/, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

function memoryIndexSummary(relativePath: string): string | null {
  switch (relativePath.toLocaleLowerCase("en-US")) {
    case "human.md":
      return "Who I'm working with";
    case "persona.md":
      return "Who I am and how I act";
    default:
      return null;
  }
}

export function requiredInitialMemoryFiles(
  tags: readonly string[] | null | undefined,
): InitialMemoryFile[] {
  return getLocalMemoryFormat(tags) === "memfs-v2"
    ? [
        {
          relativePath: "MEMORY.md",
          content: "# Memory\n",
        },
      ]
    : [];
}

export function initialMemoryFilesFromCreateBody(
  body: AgentCreateBody,
): InitialMemoryFile[] {
  const bodyRecord = body as Record<string, unknown>;
  const tags = Array.isArray(bodyRecord.tags)
    ? bodyRecord.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const format = getLocalMemoryFormat(tags);
  const blocks = Array.isArray(bodyRecord.memory_blocks)
    ? bodyRecord.memory_blocks
    : [];
  const files = new Map<string, InitialMemoryFile>();
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (typeof record.label !== "string") continue;
    const file = renderInitialMemoryFile({
      label: record.label,
      value: typeof record.value === "string" ? record.value : "",
      description:
        typeof record.description === "string" ? record.description : null,
      format,
    });
    if (!file) continue;
    if (format === "memfs-v2") {
      const collision = [...files.keys()].find(
        (path) =>
          path.toLocaleLowerCase("en-US") ===
          file.relativePath.toLocaleLowerCase("en-US"),
      );
      if (collision) {
        throw new Error(
          `MemFS v2 initial memory collision: ${collision} and ${file.relativePath}`,
        );
      }
      if (file.relativePath.toLocaleLowerCase("en-US") === "memory.md") {
        throw new Error(
          "MemFS v2 reserves root MEMORY.md for the memory index",
        );
      }
    }
    files.set(file.relativePath, file);
  }
  if (format === "memfs-v2") {
    const links = [...files.values()]
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((file) => {
        const name = memoryNameFromPath(file.relativePath);
        const summary = memoryIndexSummary(file.relativePath);
        return summary
          ? `- [${name}](${file.relativePath}) - ${summary}`
          : `- [${name}](${file.relativePath})`;
      });
    const [indexFile] = requiredInitialMemoryFiles(tags);
    if (indexFile) {
      files.set("MEMORY.md", {
        ...indexFile,
        content: ["# Memory", "", ...links, ""].join("\n"),
      });
    }
  }
  return [...files.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
}
