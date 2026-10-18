import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function inputDispositionPersistentPath(serverUrl: string): string {
  const namespace = createHash("sha256")
    .update(serverUrl)
    .digest("hex")
    .slice(0, 24);
  return join(
    homedir(),
    ".letta",
    "state",
    namespace,
    "input-dispositions-v2.json",
  );
}
