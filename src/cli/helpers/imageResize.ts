// Image resizing utilities for clipboard paste
// Follows Codex CLI's approach (codex-rs/utils/image/src/lib.rs)

export const MAX_IMAGE_WIDTH = 2000;
export const MAX_IMAGE_HEIGHT = 2000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ResizeResult {
  data: string; // base64 encoded
  mediaType: string;
  width: number;
  height: number;
  resized: boolean;
}

// Build-time constant for magick variant (set via Bun.build define when USE_MAGICK=1)
// At dev/test time this is undefined, at build time it's true/false
declare const __USE_MAGICK__: boolean | undefined;

// Use magick implementation only when explicitly built with USE_MAGICK=1
// typeof check handles dev/test case where __USE_MAGICK__ doesn't exist
const useMagick =
  typeof __USE_MAGICK__ !== "undefined" && __USE_MAGICK__ === true;

export const resizeImageIfNeeded = useMagick
  ? (await import("./imageResize.magick.js")).resizeImageIfNeeded
  : (await import("./imageResize.sharp.js")).resizeImageIfNeeded;
