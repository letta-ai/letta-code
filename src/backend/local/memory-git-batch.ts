import { execFileSync } from "node:child_process";

/**
 * `git cat-file --batch` streams every requested object through a single
 * process. Reading a memory repo with one `git show` per tracked file spawns
 * hundreds of processes on the server's event loop, which blocks every other
 * agent while the system prompt is recompiled.
 */

/** Upper bound on the stdout of a single batch process. */
const GIT_BATCH_MAX_BUFFER = 256 * 1024 * 1024;

/** Number of paths requested per batch process. */
const GIT_BATCH_CHUNK_SIZE = 1000;

/**
 * Largest file that is read, in bytes.
 *
 * The previous implementation read each file with its own `git show`, so a
 * file larger than Node's default 1 MiB `maxBuffer` failed to read and was
 * dropped from the compiled prompt. Keep that bound so the rendered prompt
 * stays byte-identical and a single oversized file cannot flood the context.
 */
const GIT_MAX_FILE_BYTES = 1024 * 1024;

/** Header of a resolved object: `<oid> <type> <size>`. */
const RESOLVED_HEADER = /^([0-9a-f]+) ([a-z]+) (\d+)$/;

/**
 * Reads the committed contents of `relativePaths` with as few git processes as
 * possible.
 *
 * Returns a map from relative path to file content, with `undefined` for paths
 * that cannot be read — the same outcome the previous per-file `git show`
 * produced for missing paths, oversized files, and unreadable entries.
 */
export function readCommittedFiles(
  memoryDir: string,
  relativePaths: string[],
): Map<string, string | undefined> {
  const contents = new Map<string, string | undefined>();
  if (relativePaths.length === 0) return contents;

  for (
    let start = 0;
    start < relativePaths.length;
    start += GIT_BATCH_CHUNK_SIZE
  ) {
    const chunk = relativePaths.slice(start, start + GIT_BATCH_CHUNK_SIZE);
    for (const [relativePath, raw] of readChunk(memoryDir, chunk)) {
      contents.set(relativePath, raw);
    }
  }

  return contents;
}

function readChunk(
  memoryDir: string,
  relativePaths: string[],
): Map<string, string | undefined> {
  let output: Buffer;
  try {
    output = execFileSync("git", ["cat-file", "--batch"], {
      cwd: memoryDir,
      input: relativePaths.map((path) => `HEAD:${path}\n`).join(""),
      encoding: null,
      maxBuffer: GIT_BATCH_MAX_BUFFER,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return readIndividually(memoryDir, relativePaths);
  }

  return parseBatchOutput(memoryDir, output, relativePaths);
}

function readIndividually(
  memoryDir: string,
  relativePaths: string[],
): Map<string, string | undefined> {
  const contents = new Map<string, string | undefined>();
  for (const relativePath of relativePaths) {
    try {
      const raw = execFileSync("git", ["show", `HEAD:${relativePath}`], {
        cwd: memoryDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      contents.set(relativePath, raw);
    } catch {
      contents.set(relativePath, undefined);
    }
  }
  return contents;
}

function parseBatchOutput(
  memoryDir: string,
  output: Buffer,
  relativePaths: string[],
): Map<string, string | undefined> {
  const contents = new Map<string, string | undefined>();
  let offset = 0;

  for (const relativePath of relativePaths) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    const header = output.toString("utf8", offset, headerEnd);
    offset = headerEnd + 1;

    const resolved = RESOLVED_HEADER.exec(header);
    if (!resolved) {
      // `<input> missing` — the path is not in the committed tree.
      contents.set(relativePath, undefined);
      continue;
    }

    const [, , type, sizeText] = resolved;
    const size = Number.parseInt(sizeText ?? "", 10);
    if (!Number.isFinite(size) || offset + size > output.length) {
      contents.set(relativePath, undefined);
      break;
    }

    // Every record ends with a newline after the object contents, so the
    // offset advances past the object data for every type — not just blobs.
    const nextOffset = offset + size + 1;

    if (type !== "blob") {
      // A gitlink resolves to a commit object rather than a file. `git show`
      // prints that commit, so keep the previous behavior for it.
      contents.set(
        relativePath,
        readIndividually(memoryDir, [relativePath]).get(relativePath),
      );
      offset = nextOffset;
      continue;
    }

    if (size > GIT_MAX_FILE_BYTES) {
      // Too large to read: the previous per-file read failed on this too.
      contents.set(relativePath, undefined);
      offset = nextOffset;
      continue;
    }

    contents.set(relativePath, output.toString("utf8", offset, offset + size));
    offset = nextOffset;
  }

  return contents;
}
