// Clipboard utilities for detecting and importing images from system clipboard
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { resizeImageIfNeeded } from "./imageResize";
import { allocateImage } from "./pasteRegistry";

/**
 * Result type for clipboard image import.
 * - placeholder: Successfully imported, contains [Image #N]
 * - error: Failed with an error message
 * - null: No image in clipboard
 */
export type ClipboardImageResult =
  | { placeholder: string; resized: boolean; width: number; height: number }
  | { error: string }
  | null;

/**
 * Copy text to system clipboard
 * Returns true if successful, false otherwise
 */
export function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "darwin") {
      execFileSync("pbcopy", [], { input: text, encoding: "utf8" });
      return true;
    } else if (process.platform === "win32") {
      execFileSync("clip", [], { input: text, encoding: "utf8" });
      return true;
    } else {
      // Linux - try xclip first, then xsel
      try {
        execFileSync("xclip", ["-selection", "clipboard"], {
          input: text,
          encoding: "utf8",
        });
        return true;
      } catch {
        try {
          execFileSync("xsel", ["--clipboard", "--input"], {
            input: text,
            encoding: "utf8",
          });
          return true;
        } catch {
          return false;
        }
      }
    }
  } catch {
    return false;
  }
}

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
]);

function countLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length + 1;
}

// Translate various image paste formats into [Image #N] placeholders
export function translatePasteForImages(paste: string): string {
  let s = paste || "";

  // 1) iTerm2 OSC 1337 inline file transfer: ESC ] 1337;File=...:BASE64 <BEL or ST>
  try {
    // Build regex via code points to avoid control chars in literal
    const ESC = "\u001B";
    const BEL = "\u0007";
    const ST = `${ESC}\\`; // ESC \
    const pattern = `${ESC}]1337;File=([^${BEL}${ESC}]*):([\\s\\S]*?)(?:${BEL}|${ST})`;
    const OSC = new RegExp(pattern, "g");
    s = s.replace(OSC, (_m, paramsStr: string, base64: string) => {
      const params: Record<string, string> = {};
      for (const seg of String(paramsStr || "").split(";")) {
        const [k, v] = seg.split("=");
        if (k && v)
          params[k.trim().toLowerCase()] = decodeURIComponent(v.trim());
      }
      const name = params.name || undefined;
      const mt = params.type || params.mime || "application/octet-stream";
      const id = allocateImage({ data: base64, mediaType: mt, filename: name });
      return `[Image #${id}]`;
    });
  } catch {}

  // 2) Data URL images
  try {
    const DATA_URL = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g;
    s = s.replace(DATA_URL, (_m, subtype: string, b64: string) => {
      const mt = `image/${subtype}`;
      const id = allocateImage({ data: b64, mediaType: mt });
      return `[Image #${id}]`;
    });
  } catch {}

  // 3) Single image file path paste
  try {
    const trimmed = s.trim();
    const singleLine = countLines(trimmed) <= 1;
    if (singleLine) {
      let filePath = trimmed;
      if (/^file:\/\//i.test(filePath)) {
        try {
          // Decode file:// URL
          const u = new URL(filePath);
          filePath = decodeURIComponent(u.pathname);
          // On Windows, pathname starts with /C:/
          if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(filePath)) {
            filePath = filePath.slice(1);
          }
        } catch {}
      }
      // If relative, resolve against CWD
      if (!isAbsolute(filePath)) filePath = resolve(process.cwd(), filePath);
      const ext = extname(filePath || "").toLowerCase();
      if (
        IMAGE_EXTS.has(ext) &&
        existsSync(filePath) &&
        statSync(filePath).isFile()
      ) {
        const buf = readFileSync(filePath);
        const b64 = buf.toString("base64");
        const mt =
          ext === ".png"
            ? "image/png"
            : ext === ".jpg" || ext === ".jpeg"
              ? "image/jpeg"
              : ext === ".gif"
                ? "image/gif"
                : ext === ".webp"
                  ? "image/webp"
                  : ext === ".bmp"
                    ? "image/bmp"
                    : ext === ".svg"
                      ? "image/svg+xml"
                      : ext === ".tif" || ext === ".tiff"
                        ? "image/tiff"
                        : ext === ".heic"
                          ? "image/heic"
                          : ext === ".heif"
                            ? "image/heif"
                            : ext === ".avif"
                              ? "image/avif"
                              : "application/octet-stream";
        const id = allocateImage({
          data: b64,
          mediaType: mt,
          filename: basename(filePath),
        });
        s = `[Image #${id}]`;
      }
    }
  } catch {}

  return s;
}

/**
 * Read image from macOS clipboard to a temp file.
 * Returns the temp file path and UTI, or null if no image in clipboard.
 */
function getClipboardImageToTempFile(): {
  tempPath: string;
  uti: string;
} | null {
  if (process.platform !== "darwin") return null;

  const tempPath = join(tmpdir(), `letta-clipboard-${Date.now()}.bin`);

  try {
    // JXA script that writes clipboard image to temp file and returns UTI
    // This avoids stdout buffer limits for large images
    const jxa = `
      ObjC.import('AppKit');
      ObjC.import('Foundation');
      (function() {
        var pb = $.NSPasteboard.generalPasteboard;
        var types = ['public.png','public.jpeg','public.tiff','public.heic','public.heif','public.bmp','public.gif'];
        for (var i = 0; i < types.length; i++) {
          var t = types[i];
          var d = pb.dataForType(t);
          if (d && d.length > 0) {
            d.writeToFileAtomically($('${tempPath}'), true);
            return t;
          }
        }
        return '';
      })();
    `;

    const uti = execFileSync("osascript", ["-l", "JavaScript", "-e", jxa], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!uti || !existsSync(tempPath)) return null;

    return { tempPath, uti };
  } catch {
    // Clean up temp file on error
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
    return null;
  }
}

const UTI_TO_MEDIA_TYPE: Record<string, string> = {
  "public.png": "image/png",
  "public.jpeg": "image/jpeg",
  "public.tiff": "image/tiff",
  "public.heic": "image/heic",
  "public.heif": "image/heif",
  "public.bmp": "image/bmp",
  "public.gif": "image/gif",
};

/**
 * Import image from macOS clipboard, resize if needed, return placeholder.
 * Uses temp file approach to avoid stdout buffer limits.
 * Resizes large images to fit within API limits (2000x2000).
 */
export async function tryImportClipboardImageMac(): Promise<ClipboardImageResult> {
  if (process.platform !== "darwin") return null;

  const clipboardResult = getClipboardImageToTempFile();
  if (!clipboardResult) return null;

  const { tempPath, uti } = clipboardResult;

  try {
    // Read the temp file
    const buffer = readFileSync(tempPath);

    // Clean up temp file immediately after reading
    try {
      unlinkSync(tempPath);
    } catch {}

    const mediaType = UTI_TO_MEDIA_TYPE[uti] || "image/png";

    // Resize if needed (handles large retina screenshots, HEIC conversion, etc.)
    const resized = await resizeImageIfNeeded(buffer, mediaType);

    // Store in registry
    const id = allocateImage({
      data: resized.data,
      mediaType: resized.mediaType,
    });

    return {
      placeholder: `[Image #${id}]`,
      resized: resized.resized,
      width: resized.width,
      height: resized.height,
    };
  } catch (err) {
    // Clean up temp file on error
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }

    const message = err instanceof Error ? err.message : String(err);
    return { error: `Image paste failed: ${message}` };
  }
}
