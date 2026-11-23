import { homedir } from "node:os";
import { join } from "node:path";

export function withNativeCliPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === "win32") return { ...env };
  const nativeBin = join(env.HOME || homedir(), ".local", "bin");
  const paths = (env.PATH ?? "/usr/bin:/bin").split(":");
  if (!paths.includes(nativeBin)) paths.push(nativeBin);
  return { ...env, PATH: paths.join(":") };
}
