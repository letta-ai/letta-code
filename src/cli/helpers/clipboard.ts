// Clipboard utilities for detecting and importing images from system clipboard
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { allocateImage } from "./pasteRegistry";

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
// Supports:
// 1) iTerm2 OSC 1337 protocol
// 2) Kitty graphics protocol
// 3) Data URLs (data:image/png;base64,...)
// 4) File paths (local files or file:// URLs)
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

  // 2) Kitty graphics protocol: ESC _G<params>;<base64>ESC\
  // Format: ESC _Ga=T,f=100;<base64-data>ESC\
  // where a=T means direct transmission, f=format (100=PNG, 32=RGBA, 24=RGB)
  try {
    const ESC = "\u001B";

    // Match Kitty graphics protocol: ESC _G...;base64ESC\
    const KITTY_PATTERN = new RegExp(
      `${ESC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_G([^;]*);([\\s\\S]*?)${ESC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\\\`,
      "g",
    );

    s = s.replace(KITTY_PATTERN, (_m, paramsStr: string, base64: string) => {
      // Parse key=value parameters
      const params: Record<string, string> = {};
      for (const pair of String(paramsStr || "").split(",")) {
        const [k, v] = pair.split("=");
        if (k && v) params[k.trim()] = v.trim();
      }

      // Only process direct transmissions (a=T or a=t)
      if (params.a !== "T" && params.a !== "t") {
        return _m; // Return original if not a direct transmission
      }

      // Determine media type from format parameter
      const format = params.f || "100"; // Default to PNG
      const mt =
        format === "100"
          ? "image/png"
          : format === "32"
            ? "image/png" // RGBA can be treated as PNG
            : format === "24"
              ? "image/png" // RGB can be treated as PNG
              : "image/png";

      const id = allocateImage({ data: base64.trim(), mediaType: mt });
      return `[Image #${id}]`;
    });
  } catch {}

  // 3) Data URL images
  try {
    const DATA_URL = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g;
    s = s.replace(DATA_URL, (_m, subtype: string, b64: string) => {
      const mt = `image/${subtype}`;
      const id = allocateImage({ data: b64, mediaType: mt });
      return `[Image #${id}]`;
    });
  } catch {}

  // 4) Single image file path paste
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

// Attempt to import an image directly from OS clipboard on macOS via JXA (built-in)
export function tryImportClipboardImageMac(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const jxa = `
      ObjC.import('AppKit');
      (function() {
        var pb = $.NSPasteboard.generalPasteboard;
        var types = ['public.png','public.jpeg','public.tiff','public.heic','public.heif','public.bmp','public.gif','public.svg-image'];
        for (var i = 0; i < types.length; i++) {
          var t = types[i];
          var d = pb.dataForType(t);
          if (d) {
            var b64 = d.base64EncodedStringWithOptions(0).js;
            return t + '|' + b64;
          }
        }
        return '';
      })();
    `;
    const out = execFileSync("osascript", ["-l", "JavaScript", "-e", jxa], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const idx = out.indexOf("|");
    if (idx <= 0) return null;
    const uti = out.slice(0, idx);
    const b64 = out.slice(idx + 1);
    if (!b64) return null;
    const map: Record<string, string> = {
      "public.png": "image/png",
      "public.jpeg": "image/jpeg",
      "public.tiff": "image/tiff",
      "public.heic": "image/heic",
      "public.heif": "image/heif",
      "public.bmp": "image/bmp",
      "public.gif": "image/gif",
      "public.svg-image": "image/svg+xml",
    };
    const mediaType = map[uti] || "image/png";
    const id = allocateImage({ data: b64, mediaType });
    return `[Image #${id}]`;
  } catch {
    return null;
  }
}
