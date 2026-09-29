import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "@/utils/file-lock";

/** API metadata updates must refresh and persist while holding the same lock. */
export async function withLocalMetadataLock<T>(
  storageDir: string | undefined,
  kind: "agent" | "conversation",
  id: string,
  update: () => T,
): Promise<T> {
  if (!storageDir) return update();
  const directory = join(storageDir, "locks");
  await mkdir(directory, { recursive: true });
  return withFileLock(
    join(directory, `${kind}-${encodeURIComponent(id)}.lock`),
    async () => update(),
  );
}
