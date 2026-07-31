import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import crossSpawn from "cross-spawn";

export type PackageManagerProcessFactory = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

function isWindowsCommandShim(command: string): boolean {
  return /\.(?:cmd|bat)$/i.test(command);
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
