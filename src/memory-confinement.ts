import {
  createMemoryConfinementLauncherWithAvailability,
  type MemoryConfinementLauncherInput,
  type MemoryConfinementLauncherResult,
} from "@/permissions/memory-confinement-launcher";
import { detectSandboxBackend } from "@/sandbox/availability";

export type {
  MemoryConfinementLauncherInput,
  MemoryConfinementLauncherResult,
} from "@/permissions/memory-confinement-launcher";

/**
 * Wrap a process in the same fail-closed filesystem policy used by Letta
 * Code's unattended memory subagents.
 *
 * The process can read the host broadly, write harness state and its own
 * memory, and cannot read or write other agents' memory. Throws when no
 * supported kernel sandbox is available rather than silently running with a
 * weaker policy.
 */
export function createMemoryConfinementLauncher(
  input: MemoryConfinementLauncherInput,
): MemoryConfinementLauncherResult {
  return createMemoryConfinementLauncherWithAvailability(
    input,
    detectSandboxBackend(),
  );
}
