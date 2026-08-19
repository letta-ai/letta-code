import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

function git(directory, args, options = {}) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function normalize(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isPreservedTargetPath(relativePath) {
  return relativePath === ".letta" || relativePath.startsWith(".letta/");
}

function committedTargetFiles(target) {
  return git(target, ["ls-tree", "-rz", "--full-tree", "HEAD"])
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\t");
      if (separator < 0) throw new Error(`Unexpected git record: ${record}`);
      const [mode, type, object] = record.slice(0, separator).split(" ");
      const relativePath = record.slice(separator + 1);
      if (type !== "blob" || mode === "120000") {
        throw new Error(
          `Unsupported committed target entry: ${relativePath} (${type} ${mode})`,
        );
      }
      return {
        path: relativePath,
        mode,
        sha256: sha256(
          git(target, ["cat-file", "blob", object], { encoding: null }),
        ),
      };
    })
    .filter((file) => !isPreservedTargetPath(file.path));
}

async function preparedFiles(root) {
  const files = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = normalize(path.join(relativeDirectory, entry.name));
      if ((await lstat(fullPath)).isSymbolicLink()) {
        throw new Error(`Prepared tree contains a symlink: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        const info = await stat(fullPath);
        files.push({
          path: relativePath,
          mode: info.mode & 0o111 ? "100755" : "100644",
          sha256: sha256(await readFile(fullPath)),
        });
      } else {
        throw new Error(`Unsupported prepared entry: ${relativePath}`);
      }
    }
  }
  await visit(root, "");
  return files;
}

export function assertNoIgnoredTargetFiles(target) {
  const ignored = git(target, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => !isPreservedTargetPath(relativePath));
  if (ignored.length > 0) {
    throw new Error(
      `Target repository has ignored files that full migration would delete: ${ignored.join(", ")}`,
    );
  }
}

export async function describeTargetChanges(target, prepared) {
  const before = new Map(
    committedTargetFiles(target).map((file) => [file.path, file]),
  );
  const after = new Map(
    (await preparedFiles(prepared)).map((file) => [file.path, file]),
  );
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [relativePath, file] of after) {
    const previous = before.get(relativePath);
    if (!previous) added.push(relativePath);
    else if (previous.mode !== file.mode || previous.sha256 !== file.sha256) {
      modified.push(relativePath);
    }
  }
  for (const relativePath of before.keys()) {
    if (!after.has(relativePath)) deleted.push(relativePath);
  }
  return { added, modified, deleted };
}
