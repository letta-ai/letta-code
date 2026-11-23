import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readUtf8TextStrict } from "@/utils/text-files";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function resolveBinaryWritePath(target: string): string {
  if (target === "~" || target.startsWith("~/")) {
    return path.join(process.env.HOME || homedir(), target.slice(1));
  }
  if (!path.isAbsolute(target)) {
    throw new Error("write_file requires an absolute path or a ~/ path");
  }
  return path.resolve(target);
}

export async function writeBase64File(params: {
  path: string;
  content: string;
  append?: boolean;
  move_to?: string;
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
  if (params.move_to === undefined) {
    return { path: target, bytesWritten: bytes.length };
  }
  const destination = resolveBinaryWritePath(params.move_to);
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(target, destination);
  return { path: destination, bytesWritten: bytes.length };
}

export async function writeUtf8FileViaTools(
  filePath: string,
  content: string,
): Promise<void> {
  const { edit } = await import("@/tools/impl/edit");
  const { write } = await import("@/tools/impl/write");

  let currentContent: string | null = null;
  try {
    currentContent = await readUtf8TextStrict(filePath);
  } catch (readErr) {
    const e = readErr as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw readErr;
  }

  if (currentContent === null) {
    await write({ file_path: filePath, content });
  } else {
    const normalizedCurrent = currentContent.replace(/\r\n/g, "\n");
    const normalizedNew = content.replace(/\r\n/g, "\n");
    if (normalizedCurrent !== normalizedNew) {
      await edit({
        file_path: filePath,
        old_string: currentContent,
        new_string: content,
      });
    }
  }
}
