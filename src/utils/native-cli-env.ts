import { homedir } from "node:os";
import { join } from "node:path";

/** Preserve configured wrappers while finding native CLI installs from a daemon. */
export function withNativeCliPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === "win32") return { ...env };
  // Desktop/daemon launches don't source login-shell startup files. Append the
  // native installer directory without executing shell startup files with secrets.
  const nativeBin = join(env.HOME || homedir(), ".local", "bin");
  const paths = (env.PATH ?? "/usr/bin:/bin").split(":");
  if (!paths.includes(nativeBin)) paths.push(nativeBin);
  return { ...env, PATH: paths.join(":") };
}
