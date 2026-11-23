import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import {
  ImageWorkerMissingError,
  resizeImageIfNeeded,
} from "@/utils/image-resize";
import { allocateImage } from "./paste-registry";

export type ClipboardImageResult =
  | { placeholder: string; resized: boolean; width: number; height: number }
  | { error: string }
  | null;

export function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "darwin") {
      execFileSync("pbcopy", [], { input: text, encoding: "utf8" });
      return true;
    } else if (process.platform === "win32") {
      execFileSync("clip", [], { input: text, encoding: "utf8" });
      return true;
    } else {
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

export function translatePasteForImages(paste: string): string {
  let s = paste || "";

  try {
    const ESC = "\u001B";
    const BEL = "\u0007";
    const ST = `${ESC}\\`;
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

  try {
    const DATA_URL = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g;
    s = s.replace(DATA_URL, (_m, subtype: string, b64: string) => {
      const mt = `image/${subtype}`;
      const id = allocateImage({ data: b64, mediaType: mt });
      return `[Image #${id}]`;
    });
  } catch {}

  try {
    const trimmed = s.trim();
    const singleLine = countLines(trimmed) <= 1;
    if (singleLine) {
      let filePath = trimmed;

      filePath = filePath.replace(/^['"]|['"]$/g, "");
      filePath = filePath.replace(/\\(?=[ '()&])/g, "");

      if (/^file:\/\//i.test(filePath)) {
        try {
          const u = new URL(filePath);
          filePath = decodeURIComponent(u.pathname);
          if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(filePath)) {
            filePath = filePath.slice(1);
          }
        } catch {}
      }
      if (!isAbsolute(filePath)) filePath = resolve(process.cwd(), filePath);
      const ext = extname(filePath || "").toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        let buf: Buffer | null = null;
        try {
          const stat = statSync(filePath);
          if (stat.isFile()) buf = readFileSync(filePath);
        } catch {}

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

function getClipboardImageToTempFile(): {
  tempPath: string;
  uti: string;
} | null {
  if (process.platform !== "darwin") return null;

  const tempPath = join(tmpdir(), `letta-clipboard-${Date.now()}.bin`);

  try {
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

export async function tryImportClipboardImageMac(): Promise<ClipboardImageResult> {
  if (process.platform !== "darwin") return null;

  const clipboardResult = getClipboardImageToTempFile();
  if (!clipboardResult) return null;

  const { tempPath, uti } = clipboardResult;

  try {
    const buffer = readFileSync(tempPath);

    try {
      unlinkSync(tempPath);
    } catch {}

    const mediaType = UTI_TO_MEDIA_TYPE[uti] || "image/png";

    const resized = await resizeImageIfNeeded(buffer, mediaType);

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
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }

    if (err instanceof ImageWorkerMissingError) {
      trackBoundaryError({
        errorType: "image_worker_missing",
        error: err,
        context: "clipboard_image_paste",
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Image paste failed: ${message}` };
  }
}
