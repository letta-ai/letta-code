import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

export function inputDispositionPersistentPath(serverUrl: string): string {
  const namespace = createHash("sha256")
    .update(serverUrl)
    .digest("hex")
    .slice(0, 24);
  return join(
    resolveGlobalConfigDir(),
    "state",
    namespace,
    "input-dispositions-v2.json",
  );
}
