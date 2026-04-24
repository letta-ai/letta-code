// Anthropic limits: 8000x8000 for single images, but 2000x2000 for many-image requests.
// We use 2000 to stay safe when conversation history accumulates multiple images.
export const MAX_IMAGE_WIDTH = 2000;
export const MAX_IMAGE_HEIGHT = 2000;

// Anthropic's API enforces a 5MB limit on image bytes (not the base64 string).
// We enforce this in the client to avoid provider-side API errors.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Match OpenClaw's decompression-bomb guard to fail closed on pathological
// images before the shared resize path spends significant work decoding them.
export const MAX_IMAGE_INPUT_PIXELS = 25_000_000;

export interface ResizeResult {
  data: string; // base64 encoded
  mediaType: string;
  width: number;
  height: number;
  resized: boolean;
}

export function isHeicMediaType(mediaType?: string | null): boolean {
  const normalized = mediaType?.trim().toLowerCase();
  return normalized === "image/heic" || normalized === "image/heif";
}

export function mediaTypeForDecodedImageFormat(
  format?: string | null,
): string | null {
  const normalized = format?.trim().toLowerCase();
  switch (normalized) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

export function canonicalizeOutputMediaType(
  decodedFormat: string | null | undefined,
  fallbackMediaType: string,
): string {
  return mediaTypeForDecodedImageFormat(decodedFormat) ?? fallbackMediaType;
}

export function assertImageHasDimensions(
  width: number,
  height: number,
  context: string,
): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      `${context} has invalid dimensions: ${String(width)}x${String(height)}`,
    );
  }
}

export function assertImageWithinBounds(
  width: number,
  height: number,
  context: string,
): void {
  assertImageHasDimensions(width, height, context);
  if (width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT) {
    throw new Error(
      `${context} exceeds ${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT}: ${width}x${height}`,
    );
  }
}

export function buildResizeResult(
  buffer: Buffer,
  mediaType: string,
  width: number,
  height: number,
  resized: boolean,
): ResizeResult {
  return {
    data: buffer.toString("base64"),
    mediaType,
    width,
    height,
    resized,
  };
}
