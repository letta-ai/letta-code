import {
  SYSTEM_PROMPT_MEMFS_ADDON,
  SYSTEM_PROMPT_MEMORY_ADDON,
} from "./promptAssets";

export type MemoryPromptMode = "standard" | "memfs";

export interface MemoryPromptDrift {
  code:
    | "legacy_memory_language_with_memfs"
    | "memfs_language_with_standard_mode"
    | "orphan_memfs_fragment";
  message: string;
}

interface Heading {
  level: number;
  title: string;
  startOffset: number;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function scanHeadingsOutsideFences(text: string): Heading[] {
  const lines = text.split("\n");
  const headings: Heading[] = [];
  let inFence = false;
  let fenceToken = "";
  let offset = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const token = fenceMatch[1] ?? fenceMatch[0] ?? "";
      const tokenChar = token.startsWith("`") ? "`" : "~";
      if (!inFence) {
        inFence = true;
        fenceToken = tokenChar;
      } else if (fenceToken === tokenChar) {
        inFence = false;
        fenceToken = "";
      }
    }

    if (!inFence) {
      const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
      if (headingMatch) {
        const hashes = headingMatch[1] ?? "";
        const rawTitle = headingMatch[2] ?? "";
        if (hashes && rawTitle) {
          const level = hashes.length;
          const title = rawTitle.replace(/\s+#*$/, "").trim();
          headings.push({
            level,
            title,
            startOffset: offset,
          });
        }
      }
    }

    offset += line.length + 1;
  }

  return headings;
}

function stripHeadingSections(
  text: string,
  shouldStrip: (heading: Heading) => boolean,
): string {
  let current = text;
  while (true) {
    const headings = scanHeadingsOutsideFences(current);
    const target = headings.find(shouldStrip);
    if (!target) {
      return current;
    }

    const nextHeading = headings.find(
      (heading) =>
        heading.startOffset > target.startOffset &&
        heading.level <= target.level,
    );
    const end = nextHeading ? nextHeading.startOffset : current.length;
    current = `${current.slice(0, target.startOffset)}${current.slice(end)}`;
  }
}

function getMemfsTailFragment(): string {
  const tailAnchor = "# See what changed";
  const start = SYSTEM_PROMPT_MEMFS_ADDON.indexOf(tailAnchor);
  if (start === -1) return "";
  return SYSTEM_PROMPT_MEMFS_ADDON.slice(start).trim();
}

function stripExactAddon(text: string, addon: string): string {
  const trimmedAddon = addon.trim();
  if (!trimmedAddon) return text;
  let current = text;
  while (current.includes(trimmedAddon)) {
    current = current.replace(trimmedAddon, "");
  }
  return current;
}

function stripOrphanMemfsTail(text: string): string {
  const tail = getMemfsTailFragment();
  if (!tail) return text;
  let current = text;
  while (current.includes(tail)) {
    current = current.replace(tail, "");
  }
  return current;
}

function compactBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function stripManagedMemorySections(systemPrompt: string): string {
  let current = normalizeNewlines(systemPrompt);

  // Strip exact current addons first (fast path).
  current = stripExactAddon(current, SYSTEM_PROMPT_MEMORY_ADDON);
  current = stripExactAddon(current, SYSTEM_PROMPT_MEMFS_ADDON);

  // Strip known orphan fragment produced by the old regex bug.
  current = stripOrphanMemfsTail(current);

  // Strip legacy/variant memory sections by markdown heading parsing.
  current = stripHeadingSections(
    current,
    (heading) => heading.title === "Memory",
  );
  current = stripHeadingSections(current, (heading) =>
    heading.title.startsWith("Memory Filesystem"),
  );

  return compactBlankLines(current);
}

export function reconcileMemoryPrompt(
  systemPrompt: string,
  mode: MemoryPromptMode,
): string {
  const base = stripManagedMemorySections(systemPrompt).trimEnd();
  const addon =
    mode === "memfs"
      ? SYSTEM_PROMPT_MEMFS_ADDON.trimStart()
      : SYSTEM_PROMPT_MEMORY_ADDON.trimStart();
  return `${base}\n\n${addon}`.trim();
}

export function detectMemoryPromptDrift(
  systemPrompt: string,
  expectedMode: MemoryPromptMode,
): MemoryPromptDrift[] {
  const prompt = normalizeNewlines(systemPrompt);
  const drifts: MemoryPromptDrift[] = [];

  const hasLegacyMemoryLanguage = prompt.includes(
    "Your memory consists of core memory (composed of memory blocks)",
  );
  const hasMemfsLanguage =
    prompt.includes("## Memory Filesystem") ||
    prompt.includes("Your memory is stored in a git repository at");
  const hasOrphanFragment =
    prompt.includes("# See what changed") &&
    prompt.includes("git add system/") &&
    prompt.includes('git commit -m "<type>: <what changed>"');

  if (expectedMode === "memfs" && hasLegacyMemoryLanguage) {
    drifts.push({
      code: "legacy_memory_language_with_memfs",
      message:
        "System prompt contains legacy memory-block language while memfs is enabled.",
    });
  }

  if (expectedMode === "standard" && hasMemfsLanguage) {
    drifts.push({
      code: "memfs_language_with_standard_mode",
      message:
        "System prompt contains Memory Filesystem language while memfs is disabled.",
    });
  }

  if (hasOrphanFragment && !hasMemfsLanguage) {
    drifts.push({
      code: "orphan_memfs_fragment",
      message:
        "System prompt contains orphaned memfs sync fragment without a full memfs section.",
    });
  }

  return drifts;
}
