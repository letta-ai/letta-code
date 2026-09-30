import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface RootPackage {
  version: string;
}

const appRoot = join(import.meta.dir, "..");
const rootPackagePath = join(appRoot, "..", "..", "package.json");
const rootPackage = JSON.parse(
  await readFile(rootPackagePath, "utf8"),
) as RootPackage;
const publishMode = process.env.LETTA_DAEMON_PUBLISH ?? "never";
const args = [
  "electron-builder",
  `--publish=${publishMode}`,
  `--config.extraMetadata.version=${rootPackage.version}`,
];
if (process.arch === "arm64") {
  args.push("--config.publish.channel=latest-arm64");
}
args.push(...process.argv.slice(2));

const processHandle = Bun.spawn(args, {
  cwd: appRoot,
  env: process.env,
  stderr: "inherit",
  stdout: "inherit",
});
const exitCode = await processHandle.exited;
process.exit(exitCode);
