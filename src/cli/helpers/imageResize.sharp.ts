// Image resizing utilities for clipboard paste
// Follows Codex CLI's approach (codex-rs/utils/image/src/lib.rs)
import sharp from "sharp";
import {
  assertImageHasDimensions,
  assertImageWithinBounds,
  buildResizeResult,
  canonicalizeOutputMediaType,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_INPUT_PIXELS,
  MAX_IMAGE_WIDTH,
  type ResizeResult,
} from "./imageResize.shared";

function createSharpInstance(buffer: Buffer) {
  return sharp(buffer, {
    failOn: "warning",
    limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
  });
}

function wrapSharpImageError(error: unknown): Error {
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("pixel limit")
  ) {
    return new Error(
      `Image exceeds the ${MAX_IMAGE_INPUT_PIXELS.toLocaleString()} pixel input limit`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

async function inspectImageBuffer(
  buffer: Buffer,
  context: string,
): Promise<{
  width: number;
  height: number;
  format?: string;
  orientation?: number;
}> {
  const metadata = await createSharpInstance(buffer)
    .metadata()
    .catch((error) => {
      throw wrapSharpImageError(error);
    });
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  assertImageHasDimensions(width, height, context);
  return {
    width,
    height,
    format: metadata.format,
    orientation: metadata.orientation,
  };
}

async function buildVerifiedResizeResult(
  buffer: Buffer,
  mediaType: string,
  resized: boolean,
  context: string,
): Promise<ResizeResult> {
  const { width, height, format } = await inspectImageBuffer(buffer, context);
  assertImageWithinBounds(width, height, context);
  return buildResizeResult(
    buffer,
    canonicalizeOutputMediaType(format, mediaType),
    width,
    height,
    resized,
  );
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
    const compressed = await createSharpInstance(buffer)
      .jpeg({ quality })
      .toBuffer();
    if (compressed.length <= MAX_IMAGE_BYTES) {
      return buildVerifiedResizeResult(
        compressed,
        "image/jpeg",
        true,
        "compressed image output",
      );
    }
  }

  // Quality reduction wasn't enough - also reduce dimensions
  const scales = [0.75, 0.5, 0.25];
  for (const scale of scales) {
    const scaledWidth = Math.floor(currentWidth * scale);
    const scaledHeight = Math.floor(currentHeight * scale);
    const reduced = await createSharpInstance(buffer)
      .resize(scaledWidth, scaledHeight, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 70 })
      .toBuffer();
    if (reduced.length <= MAX_IMAGE_BYTES) {
      return buildVerifiedResizeResult(
        reduced,
        "image/jpeg",
        true,
        "dimension-reduced image output",
      );
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
  const sourceMetadata = await inspectImageBuffer(buffer, "source image");
  const normalizedBuffer =
    sourceMetadata.orientation && sourceMetadata.orientation !== 1
      ? await createSharpInstance(buffer).rotate().toBuffer()
      : buffer;
  const image = createSharpInstance(normalizedBuffer);
  const { width, height, format } = await inspectImageBuffer(
    normalizedBuffer,
    "normalized source image",
  );

  const needsResize = width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT;

  // Determine if we can pass through the original format
  const isPassthroughFormat = format === "png" || format === "jpeg";

  if (!needsResize && isPassthroughFormat) {
    // No resize needed and format is supported - but check byte limit
    const compressed = await compressToFitByteLimit(
      normalizedBuffer,
      width,
      height,
    );
    if (compressed) {
      return compressed;
    }
    return buildVerifiedResizeResult(
      normalizedBuffer,
      inputMediaType,
      false,
      "passthrough image output",
    );
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

    const { width: resizedWidth, height: resizedHeight } =
      await inspectImageBuffer(outputBuffer, "resized image output");

    // Check byte limit after dimension resize
    const compressed = await compressToFitByteLimit(
      outputBuffer,
      resizedWidth,
      resizedHeight,
    );
    if (compressed) {
      return compressed;
    }

    return buildVerifiedResizeResult(
      outputBuffer,
      outputMediaType,
      true,
      "resized image output",
    );
  }

  // No resize needed but format needs conversion (e.g., HEIC, TIFF, etc.)
  const outputBuffer = await image.png().toBuffer();

  // Check byte limit after format conversion
  const compressed = await compressToFitByteLimit(outputBuffer, width, height);
  if (compressed) {
    return compressed;
  }

  return buildVerifiedResizeResult(
    outputBuffer,
    "image/png",
    false,
    "converted image output",
  );
}
