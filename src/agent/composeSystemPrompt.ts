import {
  resolveSystemPrompt,
  SYSTEM_PROMPT_MEMFS_ADDON,
  SYSTEM_PROMPT_MEMORY_ADDON,
} from "./promptAssets";

export type MemoryMode = "standard" | "memfs";

/** Strip the managed memory addon (always the last section, always starts with # Memory). */
export function stripMemoryAddon(system: string): string {
  const idx = system.lastIndexOf("\n# Memory\n");
  if (idx === -1) return system.trimEnd();
  return system.slice(0, idx).trimEnd();
}

/** Compose a full system prompt from base + memory addon. */
export async function composeSystemPrompt(opts: {
  preset?: string;
  customPrompt?: string;
  memoryMode: MemoryMode;
  append?: string;
}): Promise<string> {
  const base = opts.customPrompt ?? (await resolveSystemPrompt(opts.preset));
  const addon =
    opts.memoryMode === "memfs"
      ? SYSTEM_PROMPT_MEMFS_ADDON
      : SYSTEM_PROMPT_MEMORY_ADDON;
  let result = `${base.trimEnd()}\n\n${addon.trimStart()}`.trim();
  if (opts.append) result += `\n\n${opts.append}`;
  return result;
}

/** Recompose an existing agent.system with a different memory mode. */
export function recomposeMemoryAddon(
  system: string,
  memoryMode: MemoryMode,
): string {
  const base = stripMemoryAddon(system);
  const addon =
    memoryMode === "memfs"
      ? SYSTEM_PROMPT_MEMFS_ADDON
      : SYSTEM_PROMPT_MEMORY_ADDON;
  return `${base}\n\n${addon.trimStart()}`.trim();
}
