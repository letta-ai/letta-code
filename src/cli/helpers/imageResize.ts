// Image resizing utilities for clipboard paste
// Follows Codex CLI's approach (codex-rs/utils/image/src/lib.rs)
import sharp from "sharp";

// Anthropic limits: 8000x8000 for single images, but 2000x2000 for many-image requests
// We use 2000 to stay safe when conversation history accumulates multiple images
export const MAX_IMAGE_WIDTH = 2000;
export const MAX_IMAGE_HEIGHT = 2000;

export interface ResizeResult {
  data: string; // base64 encoded
  mediaType: string;
  width: number;
  height: number;
  resized: boolean;
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
  const image = sharp(buffer);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const format = metadata.format;

  const needsResize = width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT;

  // Determine if we can pass through the original format
  const isPassthroughFormat = format === "png" || format === "jpeg";

  if (!needsResize && isPassthroughFormat) {
    // No resize needed and format is supported - return original bytes
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
    const resized = image.resize(MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, {
      fit: "inside",
      withoutEnlargement: true,
    });

    // Output as PNG for lossless quality (or JPEG if input was JPEG)
    let outputBuffer: Buffer;
    let outputMediaType: string;

    if (format === "jpeg") {
      // Preserve JPEG format with good quality (Codex uses 85)
      outputBuffer = await resized.jpeg({ quality: 85 }).toBuffer();
      outputMediaType = "image/jpeg";
    } else {
      // Default to PNG for everything else
      outputBuffer = await resized.png().toBuffer();
      outputMediaType = "image/png";
    }

    const resizedMeta = await sharp(outputBuffer).metadata();
    return {
      data: outputBuffer.toString("base64"),
      mediaType: outputMediaType,
      width: resizedMeta.width ?? 0,
      height: resizedMeta.height ?? 0,
      resized: true,
    };
  }

  // No resize needed but format needs conversion (e.g., HEIC, TIFF, etc.)
  const outputBuffer = await image.png().toBuffer();
  return {
    data: outputBuffer.toString("base64"),
    mediaType: "image/png",
    width,
    height,
    resized: false,
  };
}
