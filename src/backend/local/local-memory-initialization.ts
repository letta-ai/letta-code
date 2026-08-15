import type { InitializeLocalMemoryRepoFile } from "@/agent/memory-git";
import type { AgentCreateBody } from "@/backend/backend";
import { isLocalAgentMemoryEnabled } from "@/utils/local-agent-memory";

function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function memoryBlockPath(label: string): string {
  const normalized = label.trim().replace(/\\/g, "/").replace(/\.md$/, "");
  if (isLocalAgentMemoryEnabled()) {
    const withoutSystem = normalized.replace(/^system\//, "");
    return `${withoutSystem.replaceAll("/", "_")}.md`;
  }
  if (normalized === "system" || normalized.startsWith("system/")) {
    return `${normalized}.md`;
  }
  return `system/${normalized}.md`;
}

function renderInitialMemoryFile(input: {
  label: string;
  value: string;
  description?: string | null;
}): InitializeLocalMemoryRepoFile | null {
  const relativePath = memoryBlockPath(input.label);
  const segments = relativePath.split("/").filter(Boolean);
  if (
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
    content: isLocalAgentMemoryEnabled()
      ? input.value
      : [
          "---",
          `description: ${sanitizeFrontmatterValue(description)}`,
          "---",
          input.value,
        ].join("\n"),
  };
}

export function initialAgentMemoryIndex(): InitializeLocalMemoryRepoFile {
  return {
    relativePath: "MEMORY.md",
    content: [
      "# Memory",
      "",
      "Root Markdown is core memory and is loaded on every turn.",
      "Nested memory is indexed by each directory's MEMORY.md and loaded only when needed.",
      "Agent Skills remain under skills/ and are loaded through the Skill system.",
    ].join("\n"),
  };
}

export function initialMemoryFilesFromCreateBody(
  body: AgentCreateBody,
): InitializeLocalMemoryRepoFile[] {
  const bodyRecord = body as Record<string, unknown>;
  const blocks = Array.isArray(bodyRecord.memory_blocks)
    ? bodyRecord.memory_blocks
    : [];
  const files = new Map<string, InitializeLocalMemoryRepoFile>();
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (typeof record.label !== "string") continue;
    const file = renderInitialMemoryFile({
      label: record.label,
      value: typeof record.value === "string" ? record.value : "",
      description:
        typeof record.description === "string" ? record.description : null,
    });
    if (file) files.set(file.relativePath, file);
  }
  if (isLocalAgentMemoryEnabled()) {
    files.set("MEMORY.md", initialAgentMemoryIndex());
  }
  return [...files.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
}
