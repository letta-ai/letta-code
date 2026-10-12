import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readUtf8TextStrict } from "@/utils/text-files";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Resolves a leading `~/` against the listener's home directory. */
export function resolveBinaryWritePath(target: string): string {
  if (target === "~" || target.startsWith("~/")) {
    return path.join(process.env.HOME || homedir(), target.slice(1));
  }
  if (!path.isAbsolute(target)) {
    throw new Error("write_file requires an absolute path or a ~/ path");
  }
  return path.resolve(target);
}

/**
 * Writes base64-decoded bytes directly to disk, creating parent directories.
 * `append` adds the bytes to an existing file so large files can arrive in
 * chunks that each fit in one WebSocket message.
 */
export async function writeBase64File(params: {
  path: string;
  content: string;
  append?: boolean;
}): Promise<{ path: string; bytesWritten: number }> {
  if (params.content.length % 4 !== 0 || !BASE64_PATTERN.test(params.content)) {
    throw new Error("write_file content is not valid base64");
  }
  const target = resolveBinaryWritePath(params.path);
  const bytes = Buffer.from(params.content, "base64");
  await mkdir(path.dirname(target), { recursive: true });
  if (params.append) {
    await appendFile(target, bytes);
  } else {
    await writeFile(target, bytes);
  }
  return { path: target, bytesWritten: bytes.length };
}

/**
 * UTF-8 write_file path: goes through the agent's Write/Edit tools so text
 * writes keep their CRLF normalisation and error behavior.
 */
export async function writeUtf8FileViaTools(
  filePath: string,
  content: string,
): Promise<void> {
  const { edit } = await import("@/tools/impl/edit");
  const { write } = await import("@/tools/impl/write");

  // Read current content so we can use edit for an atomic
  // read-modify-write that goes through the same code path as
  // the agent's Edit tool (CRLF normalisation, rich errors, etc.).
  let currentContent: string | null = null;
  try {
    currentContent = await readUtf8TextStrict(filePath);
  } catch (readErr) {
    const e = readErr as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw readErr;
    // ENOENT -- new file, fall through to write below
  }

  if (currentContent === null) {
    // New file -- use write so directories are created as needed.
    await write({ file_path: filePath, content });
  } else {
    // Existing file -- use edit for a full-content replacement.
    // Normalise line endings before comparing to avoid a spurious
    // "no changes" error when the only difference is CRLF vs LF.
    const normalizedCurrent = currentContent.replace(/\r\n/g, "\n");
    const normalizedNew = content.replace(/\r\n/g, "\n");
    if (normalizedCurrent !== normalizedNew) {
      await edit({
        file_path: filePath,
        old_string: currentContent,
        new_string: content,
      });
    }
    // else: content unchanged -- no-op, still respond success below
  }
}
