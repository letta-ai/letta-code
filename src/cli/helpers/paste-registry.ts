// Clipboard paste registry - manages mappings from placeholders to actual content
// Supports both large text pastes and image pastes (multi-modal)

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

export interface ImageEntry {
  data: string; // base64
  mediaType: string;
  filename?: string;
  localPath: string;
}

// Text placeholder registry (for large pasted text collapsed into a placeholder)
const textRegistry = new Map<number, string>();

// Image placeholder registry (maps id -> stable local copy + multimodal data)
const imageRegistry = new Map<number, ImageEntry>();
let imageStorageDirectory: string | undefined;
let imageStorageCleanupRegistered = false;

let nextId = 1;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/avif": ".avif",
};

const SAFE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
  ".svg",
  ".tif",
  ".tiff",
  ".avif",
]);

function detectedImageExtension(data: string): string | undefined {
  const bytes = Buffer.from(data, "base64");
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return ".jpg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return ".gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return ".webp";
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return ".bmp";
  const tiffHeader = bytes.subarray(0, 4).toString("hex");
  if (tiffHeader === "49492a00" || tiffHeader === "4d4d002a") return ".tiff";
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
    if (brand === "avif" || brand === "avis") return ".avif";
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return ".heic";
    if (["heif", "heim", "mif1", "msf1"].includes(brand)) return ".heif";
  }
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(bytes.toString("utf8")))
    return ".svg";
  return undefined;
}

function imageExtension(
  data: string,
  mediaType: string,
  filename?: string,
): string {
  const detectedExtension = detectedImageExtension(data);
  if (detectedExtension) return detectedExtension;
  const mediaExtension = IMAGE_EXTENSIONS[mediaType.toLowerCase()];
  if (mediaExtension && SAFE_IMAGE_EXTENSIONS.has(mediaExtension)) {
    return mediaExtension;
  }
  const filenameExtension = extname(basename(filename ?? "")).toLowerCase();
  return SAFE_IMAGE_EXTENSIONS.has(filenameExtension)
    ? filenameExtension
    : ".img";
}

function storeImage(
  data: string,
  mediaType: string,
  filename?: string,
): string {
  if (!imageStorageDirectory) {
    imageStorageDirectory = mkdtempSync(join(tmpdir(), "letta-code-images-"));
    if (process.platform !== "win32") {
      // mkdtemp normally honors 0700, but set the mode explicitly in case umask
      // or an unusual runtime implementation created it more permissively.
      chmodSync(imageStorageDirectory, 0o700);
    }
  }
  if (!imageStorageCleanupRegistered) {
    imageStorageCleanupRegistered = true;
    process.once("exit", () => {
      if (imageStorageDirectory) {
        rmSync(imageStorageDirectory, { recursive: true, force: true });
      }
    });
  }

  const extension = imageExtension(data, mediaType, filename);
  const localPath = join(imageStorageDirectory, `${randomUUID()}${extension}`);
  writeFileSync(localPath, Buffer.from(data, "base64"), { mode: 0o600 });
  return localPath;
}

// ---------- Text placeholders ----------

export function allocatePaste(content: string): number {
  const id = nextId++;
  textRegistry.set(id, content);
  return id;
}

export function resolvePlaceholders(text: string): string {
  if (!text) return text;
  // First resolve text placeholders
  let result = text.replace(
    /\[Pasted text #(\d+) \+(\d+) lines\]/g,
    (_match, idStr) => {
      const id = Number(idStr);
      const content = textRegistry.get(id);
      return content !== undefined ? content : _match;
    },
  );
  // Then convert visual newline indicators back to real newlines
  result = result.replace(/↵/g, "\n");
  return result;
}

export function extractTextPlaceholderIds(text: string): number[] {
  const ids: number[] = [];
  if (!text) return ids;
  const re = /\[Pasted text #(\d+) \+(\d+) lines\]/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: Standard pattern for regex matching
  while ((match = re.exec(text)) !== null) {
    const id = Number(match[1]);
    if (!Number.isNaN(id)) ids.push(id);
  }
  return ids;
}

export function hasAnyTextPlaceholders(text: string): boolean {
  return /\[Pasted text #\d+ \+\d+ lines\]/.test(text || "");
}

// ---------- Image placeholders ----------

export function allocateImage(args: {
  data: string;
  mediaType: string;
  filename?: string;
}): number {
  const id = nextId++;
  imageRegistry.set(id, {
    data: args.data,
    mediaType: args.mediaType,
    filename: args.filename,
    localPath: storeImage(args.data, args.mediaType, args.filename),
  });
  return id;
}

export function getImage(id: number): ImageEntry | undefined {
  return imageRegistry.get(id);
}

export function extractImagePlaceholderIds(text: string): number[] {
  const ids: number[] = [];
  if (!text) return ids;
  const re = /\[Image #(\d+)\]/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: Standard pattern for regex matching
  while ((match = re.exec(text)) !== null) {
    const id = Number(match[1]);
    if (!Number.isNaN(id)) ids.push(id);
  }
  return ids;
}

export function hasAnyImagePlaceholders(text: string): boolean {
  return /\[Image #\d+\]/.test(text || "");
}

// ---------- Cleanup ----------

export function clearPlaceholdersInText(text: string): void {
  // Clear text placeholders referenced in this text
  for (const id of extractTextPlaceholderIds(text)) {
    if (textRegistry.has(id)) textRegistry.delete(id);
  }
  // Clear image placeholders referenced in this text
  for (const id of extractImagePlaceholderIds(text)) {
    if (imageRegistry.has(id)) imageRegistry.delete(id);
  }
}

// ---------- Content Builder ----------

// Convert display text (with placeholders) into Letta content parts
// Text placeholders are resolved; image placeholders become image content
type Base64ImageSource = { type: "base64"; media_type: string; data: string };
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: Base64ImageSource };

export function buildMessageContentFromDisplay(text: string): ContentPart[] {
  const parts: ContentPart[] = [];
  if (!text) return [{ type: "text", text: "" }];

  const re = /\[Image #(\d+)\]/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  const pushText = (s: string) => {
    if (!s) return;
    const resolved = resolvePlaceholders(s);
    if (resolved.length === 0) return;
    const prev = parts[parts.length - 1];
    if (prev && prev.type === "text") {
      prev.text = (prev.text || "") + resolved;
    } else {
      parts.push({ type: "text", text: resolved });
    }
  };

  // biome-ignore lint/suspicious/noAssignInExpressions: Standard pattern for regex matching
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(lastIdx, start);
    pushText(before);
    const id = Number(match[1]);
    const img = getImage(id);
    if (img?.data) {
      pushText(
        `<system-reminder>Image available at ${JSON.stringify(img.localPath)}</system-reminder>\n`,
      );
      parts.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType || "image/jpeg",
          data: img.data,
        },
      });
    } else {
      // If mapping missing, keep the literal placeholder as text
      pushText(match[0]);
    }
    lastIdx = end;
  }
  // Remainder
  pushText(text.slice(lastIdx));

  if (parts.length === 0) return [{ type: "text", text }];
  return parts;
}
