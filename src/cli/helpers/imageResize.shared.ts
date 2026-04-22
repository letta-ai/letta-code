// Anthropic limits: 8000x8000 for single images, but 2000x2000 for many-image requests.
// We use 2000 to stay safe when conversation history accumulates multiple images.
export const MAX_IMAGE_WIDTH = 2000;
export const MAX_IMAGE_HEIGHT = 2000;

// Anthropic's API enforces a 5MB limit on image bytes (not the base64 string).
// We enforce this in the client to avoid provider-side API errors.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ResizeResult {
  data: string; // base64 encoded
  mediaType: string;
  width: number;
  height: number;
  resized: boolean;
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
