import { isVersionBelow } from "@/utils/version";
import packageJson from "../package.json";

export const MINIMUM_BUN_VERSION = packageJson.engines.bun.replace(/^>=/, "");

export function assertSupportedBunRuntime(
  bunVersion: string | undefined = process.versions.bun,
): void {
  if (!bunVersion || !isVersionBelow(bunVersion, MINIMUM_BUN_VERSION)) {
    return;
  }

  throw new Error(
    `Letta Code cannot run on Bun ${bunVersion}. Bun ${MINIMUM_BUN_VERSION} or newer is required because older versions can stop reading child-process output. Upgrade Bun, or install Letta Code from npm to run it with Node.`,
  );
}
