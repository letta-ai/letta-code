// Image resizing utilities for clipboard paste
// Follows Codex CLI's approach (codex-rs/utils/image/src/lib.rs)
// Rewritten to use imgkit (Rust-based, faster than sharp, easier to package)
import { metadata, toJpeg, toPng, transform } from "imgkit";

// Anthropic limits: 8000x8000 for single images, but 2000x2000 for many-image requests
// We use 2000 to stay safe when conversation history accumulates multiple images
export const MAX_IMAGE_WIDTH = 2000;
export const MAX_IMAGE_HEIGHT = 2000;

// Anthropic's API enforces a 5MB limit on image bytes (not base64 string)
// We enforce this in the client to avoid API errors
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB = 5,242,880 bytes

export interface ResizeResult {
  data: string; // base64 encoded
  mediaType: string;
  width: number;
  height: number;
  resized: boolean;
}

/**
 * Compress an image to fit within MAX_IMAGE_BYTES using progressive JPEG quality reduction.
 * If quality reduction alone isn't enough, also reduces dimensions.
 * Returns null if compression is not needed (image already under limit).
 */
async function compressToFitByteLimit(
  buffer: Buffer,
  currentWidth: number,
  currentHeight: number,
): Promise<ResizeResult | null> {
  // Check if compression is needed
  if (buffer.length <= MAX_IMAGE_BYTES) {
    return null; // No compression needed
  }

  // Try progressive JPEG quality reduction
  const qualities = [85, 70, 55, 40];
  for (const quality of qualities) {
    const compressed = await toJpeg(buffer, { quality });
    if (compressed.length <= MAX_IMAGE_BYTES) {
      const meta = await metadata(compressed);
      return {
        data: compressed.toString("base64"),
        mediaType: "image/jpeg",
        width: meta.width ?? currentWidth,
        height: meta.height ?? currentHeight,
        resized: true,
      };
    }
  }

  // Quality reduction wasn't enough - also reduce dimensions
  const scales = [0.75, 0.5, 0.25];
  for (const scale of scales) {
    const scaledWidth = Math.floor(currentWidth * scale);
    const scaledHeight = Math.floor(currentHeight * scale);
    const reduced = await transform(buffer, {
      resize: {
        width: scaledWidth,
        height: scaledHeight,
        fit: "inside",
      },
      output: {
        format: "jpeg",
        jpeg: { quality: 70 },
      },
    });
    if (reduced.length <= MAX_IMAGE_BYTES) {
      const meta = await metadata(reduced);
      return {
        data: reduced.toString("base64"),
        mediaType: "image/jpeg",
        width: meta.width ?? scaledWidth,
        height: meta.height ?? scaledHeight,
        resized: true,
      };
    }
  }

  // Extremely rare: even 25% scale at q70 doesn't fit
  throw new Error(
    `Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds 5MB limit even after compression`,
  );
}

/**
 * Resize image if it exceeds MAX_IMAGE_WIDTH or MAX_IMAGE_HEIGHT.
 * Uses 'inside' fit to preserve aspect ratio (like Codex's resize behavior).
 * Returns original if already within limits and format is supported.
 */
export async function resizeImageIfNeeded(
  buffer: Buffer,
  inputMediaType: string,
): Promise<ResizeResult> {
  const meta = await metadata(buffer);
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const format = meta.format;

  const needsResize = width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT;

  // Determine if we can pass through the original format
  const isPassthroughFormat = format === "png" || format === "jpeg";

  if (!needsResize && isPassthroughFormat) {
    // No resize needed and format is supported - but check byte limit
    const compressed = await compressToFitByteLimit(buffer, width, height);
    if (compressed) {
      return compressed;
    }
    return {
      data: buffer.toString("base64"),
      mediaType: inputMediaType,
      width,
      height,
      resized: false,
    };
  }

  if (needsResize) {
    // Resize preserving aspect ratio
    // Use 'inside' fit which is equivalent to Codex's resize behavior
    // Output as PNG for lossless quality (or JPEG if input was JPEG)
    let outputBuffer: Buffer;
    let outputMediaType: string;

    if (format === "jpeg") {
      // Preserve JPEG format with good quality (Codex uses 85)
      outputBuffer = await transform(buffer, {
        resize: {
          width: MAX_IMAGE_WIDTH,
          height: MAX_IMAGE_HEIGHT,
          fit: "inside",
        },
        output: {
          format: "jpeg",
          jpeg: { quality: 85 },
        },
      });
      outputMediaType = "image/jpeg";
    } else {
      // Default to PNG for everything else
      outputBuffer = await transform(buffer, {
        resize: {
          width: MAX_IMAGE_WIDTH,
          height: MAX_IMAGE_HEIGHT,
          fit: "inside",
        },
        output: {
          format: "png",
        },
      });
      outputMediaType = "image/png";
    }

    const resizedMeta = await metadata(outputBuffer);
    const resizedWidth = resizedMeta.width ?? 0;
    const resizedHeight = resizedMeta.height ?? 0;

    // Check byte limit after dimension resize
    const compressed = await compressToFitByteLimit(
      outputBuffer,
      resizedWidth,
      resizedHeight,
    );
    if (compressed) {
      return compressed;
    }

    return {
      data: outputBuffer.toString("base64"),
      mediaType: outputMediaType,
      width: resizedWidth,
      height: resizedHeight,
      resized: true,
    };
  }

  // No resize needed but format needs conversion (e.g., HEIC, TIFF, etc.)
  const outputBuffer = await toPng(buffer);

  // Check byte limit after format conversion
  const compressed = await compressToFitByteLimit(outputBuffer, width, height);
  if (compressed) {
    return compressed;
  }

  return {
    data: outputBuffer.toString("base64"),
    mediaType: "image/png",
    width,
    height,
    resized: false,
  };
}
