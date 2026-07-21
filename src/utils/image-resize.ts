// Image resizing utilities for clipboard paste
// Follows Codex CLI's approach (codex-rs/utils/image/src/lib.rs)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isHeicMediaType, type ResizeResult } from "./image-resize.shared";

export type { ResizeResult } from "./image-resize.shared";
export {
  isHeicMediaType,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_INPUT_PIXELS,
  MAX_IMAGE_WIDTH,
} from "./image-resize.shared";

// Build-time constant for magick variant (set via Bun.build define when USE_MAGICK=1)
// At dev/test time this is undefined, at build time it's true/false
declare const __USE_MAGICK__: boolean | undefined;

// Use magick implementation only when explicitly built with USE_MAGICK=1
// typeof check handles dev/test case where __USE_MAGICK__ doesn't exist
const useMagick =
  typeof __USE_MAGICK__ !== "undefined" && __USE_MAGICK__ === true;

const magickResizeImageIfNeeded = useMagick
  ? (await import("@/utils/image-resize.magick.js")).resizeImageIfNeeded
  : null;

function resolveImageWorkerPath(): string {
  const sourceWorkerPath = fileURLToPath(
    new URL("./image-resize-worker.ts", import.meta.url),
  );
  if (existsSync(sourceWorkerPath)) {
    return sourceWorkerPath;
  }
  return fileURLToPath(new URL("./image-resize-worker.js", import.meta.url));
}

// Keep Sharp/libvips outside the Ink process: native GLib diagnostics write
// directly to the process stderr and cannot be intercepted at the JS layer.
function resizeWithSharpWorker(
  buffer: Buffer,
  inputMediaType: string,
): Promise<ResizeResult> {
  return new Promise((resolve, reject) => {
    const workerPath = resolveImageWorkerPath();
    const child = spawn(process.execPath, [workerPath, inputMediaType], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let processError: Error | null = null;
    let stdinError: Error | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    child.on("error", (error) => {
      processError = error;
    });
    child.on("close", (exitCode, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (processError) {
        reject(
          new Error(`Failed to launch image worker: ${processError.message}`),
        );
        return;
      }
      if (exitCode !== 0) {
        const reason = stderr
          ? stderr
          : `Image worker exited ${signal ? `from signal ${signal}` : `with code ${String(exitCode)}`}`;
        reject(new Error(reason));
        return;
      }
      if (stdinError) {
        reject(
          new Error(`Failed to send image to worker: ${stdinError.message}`),
        );
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      try {
        resolve(JSON.parse(stdout) as ResizeResult);
      } catch {
        reject(new Error("Image worker returned an invalid response"));
      }
    });

    child.stdin.end(buffer);
  });
}

async function resizeWithConfiguredBackend(
  buffer: Buffer,
  inputMediaType: string,
): Promise<ResizeResult> {
  if (magickResizeImageIfNeeded) {
    return await magickResizeImageIfNeeded(buffer, inputMediaType);
  }
  return await resizeWithSharpWorker(buffer, inputMediaType);
}

export async function resizeImageIfNeeded(
  buffer: Buffer,
  inputMediaType: string,
): Promise<ResizeResult> {
  if (process.platform === "darwin" && isHeicMediaType(inputMediaType)) {
    try {
      const { convertHeicToJpegWithSips } = await import(
        "@/utils/image-resize.sips.js"
      );
      const convertedBuffer = await convertHeicToJpegWithSips(buffer);
      return await resizeWithConfiguredBackend(convertedBuffer, "image/jpeg");
    } catch {
      // Fall through to the configured backend so non-sips environments still
      // get the existing behavior.
    }
  }

  return await resizeWithConfiguredBackend(buffer, inputMediaType);
}
