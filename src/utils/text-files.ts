import { readFile, writeFile } from "node:fs/promises";

const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export type Utf16Bom = "UTF-16LE" | "UTF-16BE";

export function getUtf16Bom(bytes: Uint8Array): Utf16Bom | null {
  if (bytes.length < 2) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "UTF-16LE";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "UTF-16BE";
  return null;
}

export function invalidUtf8TextFileMessage(
  filePath: string,
  detail?: Utf16Bom,
): string {
  if (detail) {
    return `File is not valid UTF-8 text: ${filePath}. Detected ${detail} BOM; convert the file to UTF-8 and retry.`;
  }

  return `File is not valid UTF-8 text: ${filePath}. The file contains bytes that cannot be decoded as UTF-8.`;
}

export function decodeUtf8TextStrict(
  bytes: Uint8Array,
  filePath: string,
): string {
  const utf16Bom = getUtf16Bom(bytes);
  if (utf16Bom) {
    throw new Error(invalidUtf8TextFileMessage(filePath, utf16Bom));
  }

  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error(invalidUtf8TextFileMessage(filePath));
  }
}

export async function readUtf8TextStrict(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return decodeUtf8TextStrict(bytes, filePath);
}

export async function writeUtf8Text(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFile(filePath, Buffer.from(content, "utf8"));
}
