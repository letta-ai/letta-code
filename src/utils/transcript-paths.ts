import { join } from "node:path";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

export const TRANSCRIPT_ROOT_ENV = "LETTA_TRANSCRIPT_ROOT";

export function getTranscriptRoot(): string {
  const envRoot = process.env[TRANSCRIPT_ROOT_ENV]?.trim();
  if (envRoot) {
    return envRoot;
  }
  return join(resolveGlobalConfigDir(), "transcripts");
}
