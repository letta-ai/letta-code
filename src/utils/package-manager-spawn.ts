import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import { createRequire } from "node:module";

export type PackageManagerProcessFactory = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

const requireFromHere = createRequire(import.meta.url);
const crossSpawn = requireFromHere(
  "cross-spawn",
) as PackageManagerProcessFactory;

function isWindowsCommandShim(command: string): boolean {
  return command.toLowerCase().endsWith(".cmd");
}

export function getPackageManagerProcessFactory({
  nativeSpawn = spawn,
  platform = process.platform,
  windowsSpawn = crossSpawn,
}: {
  nativeSpawn?: PackageManagerProcessFactory;
  platform?: NodeJS.Platform;
  windowsSpawn?: PackageManagerProcessFactory;
} = {}): PackageManagerProcessFactory {
  if (platform !== "win32") {
    return nativeSpawn;
  }

  return (command, args, options) => {
    // Native Node spawn rejects npm/pnpm .cmd shims with EINVAL on Windows.
    // cross-spawn preserves argv boundaries while safely routing shims through cmd.exe.
    const spawnImpl = isWindowsCommandShim(command)
      ? windowsSpawn
      : nativeSpawn;
    return spawnImpl(command, args, options);
  };
}
