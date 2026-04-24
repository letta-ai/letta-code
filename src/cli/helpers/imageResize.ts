// Image resizing utilities for clipboard paste
// Follows Codex CLI's approach (codex-rs/utils/image/src/lib.rs)

import { isHeicMediaType } from "./imageResize.shared";

export type { ResizeResult } from "./imageResize.shared";
export {
  isHeicMediaType,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_INPUT_PIXELS,
  MAX_IMAGE_WIDTH,
} from "./imageResize.shared";

// Build-time constant for magick variant (set via Bun.build define when USE_MAGICK=1)
// At dev/test time this is undefined, at build time it's true/false
declare const __USE_MAGICK__: boolean | undefined;

// Use magick implementation only when explicitly built with USE_MAGICK=1
// typeof check handles dev/test case where __USE_MAGICK__ doesn't exist
const useMagick =
  typeof __USE_MAGICK__ !== "undefined" && __USE_MAGICK__ === true;

const backendResizeImageIfNeeded = useMagick
  ? (await import("./imageResize.magick.js")).resizeImageIfNeeded
  : (await import("./imageResize.sharp.js")).resizeImageIfNeeded;

export async function resizeImageIfNeeded(
  buffer: Buffer,
  inputMediaType: string,
) {
  if (process.platform === "darwin" && isHeicMediaType(inputMediaType)) {
    try {
      const { convertHeicToJpegWithSips } = await import(
        "./imageResize.sips.js"
      );
      const convertedBuffer = await convertHeicToJpegWithSips(buffer);
      return await backendResizeImageIfNeeded(convertedBuffer, "image/jpeg");
    } catch {
      // Fall through to the configured backend so non-sips environments still
      // get the existing behavior.
    }
  }

  return await backendResizeImageIfNeeded(buffer, inputMediaType);
}
