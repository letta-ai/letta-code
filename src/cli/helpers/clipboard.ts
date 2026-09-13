// Clipboard utilities for detecting and importing images from system clipboard
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { resizeImageIfNeeded } from "@/utils/image-resize";
import { allocateImage } from "./paste-registry";

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

  // 3) Single image file path paste (including drag-and-drop from Finder/screenshot)
  try {
    const trimmed = s.trim();
    const singleLine = countLines(trimmed) <= 1;
    if (singleLine) {
      let filePath = trimmed;

      // Strip surrounding quotes and shell-escape characters that terminals
      // add when drag-dropping files (e.g. '/path/to/file.png' or path\ with\ spaces)
      filePath = filePath.replace(/^['"]|['"]$/g, "");
      filePath = filePath.replace(/\\(?=[ '()&])/g, "");

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
      if (IMAGE_EXTS.has(ext)) {
        let buf: Buffer | null = null;
        try {
          const stat = statSync(filePath);
          if (stat.isFile()) buf = readFileSync(filePath);
        } catch {
          // File may not exist (e.g. macOS cleaned up temp screenshot)
        }

        // macOS screenshot temp files (TemporaryItems/NSIRD_screencaptureui_*)
        // may be cleaned up before we can read them. Fall back to reading the
        // image directly from the clipboard via NSPasteboard.
        let clipboardMediaType: string | null = null;
        if (
          !buf &&
          process.platform === "darwin" &&
          /TemporaryItems\/.*screencaptureui/i.test(filePath)
        ) {
          const clipResult = getClipboardImageToTempFile();
          if (clipResult) {
            try {
              buf = readFileSync(clipResult.tempPath);
              clipboardMediaType = UTI_TO_MEDIA_TYPE[clipResult.uti] || null;
              try {
                unlinkSync(clipResult.tempPath);
              } catch {}
            } catch {}
          }
        }

        if (buf && buf.length > 0) {
          const b64 = buf.toString("base64");
          const mt =
            clipboardMediaType ||
            (ext === ".png"
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
                                : "application/octet-stream");
          const id = allocateImage({
            data: b64,
            mediaType: mt,
            filename: basename(filePath),
          });
          s = `[Image #${id}]`;
        }
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

/**
 * Detect available clipboard tool on Linux.
 * Returns the command and args to read image data from clipboard,
 * or null if no clipboard tool is available.
 */
function getLinuxClipboardTool(): { cmd: string; args: string[] } | null {
  // Wayland: wl-paste
  try {
    execFileSync("which", ["wl-paste"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { cmd: "wl-paste", args: ["-t", "image/png"] };
  } catch {}

  // X11: xclip
  try {
    execFileSync("which", ["xclip"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return {
      cmd: "xclip",
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
    };
  } catch {}

  // X11: xsel (no image type support, but try anyway)
  try {
    execFileSync("which", ["xsel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { cmd: "xsel", args: ["--clipboard", "--output"] };
  } catch {}

  return null;
}

/**
 * Check if the Linux clipboard contains an image.
 * Uses wl-paste (Wayland) or xclip (X11) to read image data.
 */
function getLinuxClipboardImage(): Buffer | null {
  const tool = getLinuxClipboardTool();
  if (!tool) return null;

  try {
    const buffer = execFileSync(tool.cmd, tool.args, {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 50 * 1024 * 1024, // 50MB max
    });

    // xsel may return text data, so verify it looks like image data
    // PNG files start with the magic bytes: 89 50 4E 47
    if (buffer.length > 0) {
      // Check for PNG magic bytes
      if (
        buffer.length >= 4 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      ) {
        return buffer;
      }
      // Check for JPEG magic bytes: FF D8 FF
      if (
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
      ) {
        return buffer;
      }
      // Check for GIF magic bytes: 47 49 46 38
      if (
        buffer.length >= 4 &&
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38
      ) {
        return buffer;
      }
      // Check for WebP magic bytes: 52 49 46 46 ... 57 45 42 50
      if (
        buffer.length >= 12 &&
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
      ) {
        return buffer;
      }
      // Check for BMP magic bytes: 42 4D
      if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
        return buffer;
      }
      // If using wl-paste with explicit image type, trust the output
      if (tool.cmd === "wl-paste") {
        return buffer;
      }
    }
  } catch {}

  return null;
}

/**
 * Detect image format from buffer magic bytes.
 */
function detectImageMediaType(buffer: Buffer): string {
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }
  return "image/png"; // default
}

/**
 * Import image from Linux clipboard, resize if needed, return placeholder.
 * Uses wl-paste (Wayland) or xclip (X11) to read image data.
 * Resizes large images to fit within API limits (2000x2000).
 */
export async function tryImportClipboardImageLinux(): Promise<ClipboardImageResult> {
  if (process.platform !== "linux") return null;

  const buffer = getLinuxClipboardImage();
  if (!buffer) return null;

  try {
    const mediaType = detectImageMediaType(buffer);

    // Resize if needed
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
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Image paste failed: ${message}` };
  }
}

/**
 * Cross-platform clipboard image import.
 * Dispatches to the appropriate platform-specific implementation.
 */
export async function tryImportClipboardImage(): Promise<ClipboardImageResult> {
  if (process.platform === "darwin") {
    return tryImportClipboardImageMac();
  }
  if (process.platform === "linux") {
    return tryImportClipboardImageLinux();
  }
  return null;
}
