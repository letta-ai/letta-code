import { statSync } from "node:fs";
import { getScopedMemoryFilesystemRoot } from "./memory-filesystem";

/** Only advertise memory that is available on this machine. */
export function buildParentMemoryNote(
  parentAgentId: string,
): string | undefined {
  const directory = getScopedMemoryFilesystemRoot(parentAgentId);
  try {
    if (!statSync(directory).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return `Your parent agent (${parentAgentId}) keeps its memory as Markdown files at \`${directory}\`; attached shared-memory repos sit next to it. Read them for context on the user, project and conventions; don't edit or commit there unless asked.`;
}
