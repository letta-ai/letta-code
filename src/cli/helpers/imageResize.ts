// Image resizing utilities for clipboard paste
// Follows Codex CLI's approach (codex-rs/utils/image/src/lib.rs)
import { feature } from "bun:bundle";

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

// Import the correct implementation based on feature flag
export const resizeImageIfNeeded = feature("USE_MAGICK")
  ? (await import("./imageResize.magick.js")).resizeImageIfNeeded
  : (await import("./imageResize.sharp.js")).resizeImageIfNeeded;
