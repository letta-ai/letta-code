import { BWRAP_BIN, buildBwrapArgs } from "./bwrap.js";
import type { FsSandboxPolicy, SandboxBackend } from "./policy.js";
import { buildSeatbeltArgs, SANDBOX_EXEC_PATH } from "./seatbelt.js";

export interface WrapOptions {
  backend: SandboxBackend | null;
  bwrapPath?: string;
}

export function wrapLauncher(
  launcher: string[],
  policy: FsSandboxPolicy,
  options: WrapOptions,
): string[] | null {
  if (!options.backend) return null;
  if (launcher.length === 0) return null;

  switch (options.backend) {
    case "seatbelt":
      return [
        SANDBOX_EXEC_PATH,
        ...buildSeatbeltArgs(policy),
        "--",
        ...launcher,
      ];
    case "bwrap":
      return [
        options.bwrapPath ?? BWRAP_BIN,
        ...buildBwrapArgs(policy),
        "--",
        ...launcher,
      ];
  }
}
