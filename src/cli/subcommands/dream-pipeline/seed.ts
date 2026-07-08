// Seed a fresh, standalone memory filesystem git repo for a batch reflection
// agent to write into. Uses the same starter memory blocks and file rendering
// as a newly created letta-code agent (so seeded content cannot drift from
// production) and the same repo initialization as the local backend, ending
// with an initial commit so agent edits are inspectable via `git log -p`.

import { getDefaultMemoryBlocks } from "@/agent/memory";
import {
  type InitializeLocalMemoryRepoFile,
  initializeLocalMemoryRepo,
} from "@/agent/memory-git";
import { renderInitialMemoryFile } from "@/backend/local/local-backend";

export async function seedFreshMemoryTree(
  memoryDir: string,
  agentId: string,
): Promise<void> {
  const blocks = await getDefaultMemoryBlocks();
  const files: InitializeLocalMemoryRepoFile[] = [];
  for (const block of blocks) {
    if (typeof block.label !== "string") continue;
    const file = renderInitialMemoryFile({
      label: block.label,
      value: typeof block.value === "string" ? block.value : "",
      description:
        typeof block.description === "string" ? block.description : null,
    });
    if (file) files.push(file);
  }
  await initializeLocalMemoryRepo({
    memoryDir,
    agentId,
    authorName: "Dream Pipeline",
    files,
  });
}
