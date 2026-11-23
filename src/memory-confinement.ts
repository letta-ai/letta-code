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

export function createMemoryConfinementLauncher(
  input: MemoryConfinementLauncherInput,
): MemoryConfinementLauncherResult {
  return createMemoryConfinementLauncherWithAvailability(
    input,
    detectSandboxBackend(),
  );
}
