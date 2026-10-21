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
  return `Your parent agent (${parentAgentId}) keeps its memory as Markdown files at \`${directory}\`; attached shared-memory repos sit next to it. If the task depends on context about the user, project, people or conventions, check there first: start with \`MEMORY.md\` and the directory indexes, then open only the files that look relevant. Don't edit or commit there unless asked.`;
}
