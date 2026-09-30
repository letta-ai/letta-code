import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

const appRoot = join(import.meta.dir, "..");
const repositoryRoot = join(appRoot, "..", "..");
const runtimeRoot = join(appRoot, "runtime");
const runtimeFiles = ["letta.js", "image-resize-worker.js", "package.json"];
const runtimeDirectories = ["skills"];

await rm(runtimeRoot, { force: true, recursive: true });
await mkdir(runtimeRoot, { recursive: true });

for (const file of runtimeFiles) {
  await cp(join(repositoryRoot, file), join(runtimeRoot, basename(file)));
}
for (const directory of runtimeDirectories) {
  await cp(join(repositoryRoot, directory), join(runtimeRoot, directory), {
    recursive: true,
  });
}
await mkdir(join(runtimeRoot, "assets"), { recursive: true });
await cp(
  join(repositoryRoot, "assets", "tutor-profile.png"),
  join(runtimeRoot, "assets", "tutor-profile.png"),
);
