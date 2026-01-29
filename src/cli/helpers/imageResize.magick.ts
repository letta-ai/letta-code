// Image resizing utilities for clipboard paste
// Follows Codex CLI's approach (codex-rs/utils/image/src/lib.rs)
import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

console.log("USING MAGICK VARIANT");

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
 * Get image dimensions using ImageMagick identify
 */
async function getImageDimensions(
  buffer: Buffer,
): Promise<{ width: number; height: number; format: string }> {
  const tempInput = join(
    tmpdir(),
    `image-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tempInput, buffer);

  try {
    const output = execSync(
      `magick identify -format "%w %h %m" "${tempInput}"`,
      {
        encoding: "utf-8",
      },
    );
    const [width, height, format] = output.trim().split(" ");
    if (!width || !height || !format) {
      throw new Error("Failed to get image dimensions");
    }
    return {
      width: parseInt(width, 10),
      height: parseInt(height, 10),
      format: format.toLowerCase(),
    };
  } finally {
    unlinkSync(tempInput);
  }
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

  const tempInput = join(
    tmpdir(),
    `compress-input-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tempInput, buffer);

  try {
    // Try progressive JPEG quality reduction
    const qualities = [85, 70, 55, 40];
    for (const quality of qualities) {
      const tempOutput = join(
        tmpdir(),
        `compress-output-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
      );
      try {
        execSync(`magick "${tempInput}" -quality ${quality} "${tempOutput}"`, {
          stdio: "ignore",
        });
        const compressed = readFileSync(tempOutput);
        if (compressed.length <= MAX_IMAGE_BYTES) {
          const { width, height } = await getImageDimensions(compressed);
          return {
            data: compressed.toString("base64"),
            mediaType: "image/jpeg",
            width,
            height,
            resized: true,
          };
        }
      } finally {
        try {
          unlinkSync(tempOutput);
        } catch {}
      }
    }

    // Quality reduction wasn't enough - also reduce dimensions
    const scales = [0.75, 0.5, 0.25];
    for (const scale of scales) {
      const scaledWidth = Math.floor(currentWidth * scale);
      const scaledHeight = Math.floor(currentHeight * scale);
      const tempOutput = join(
        tmpdir(),
        `compress-output-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
      );
      try {
        execSync(
          `magick "${tempInput}" -resize ${scaledWidth}x${scaledHeight} -quality 70 "${tempOutput}"`,
          {
            stdio: "ignore",
          },
        );
        const reduced = readFileSync(tempOutput);
        if (reduced.length <= MAX_IMAGE_BYTES) {
          const { width, height } = await getImageDimensions(reduced);
          return {
            data: reduced.toString("base64"),
            mediaType: "image/jpeg",
            width,
            height,
            resized: true,
          };
        }
      } finally {
        try {
          unlinkSync(tempOutput);
        } catch {}
      }
    }

    // Extremely rare: even 25% scale at q70 doesn't fit
    throw new Error(
      `Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds 5MB limit even after compression`,
    );
  } finally {
    unlinkSync(tempInput);
  }
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
  const { width, height, format } = await getImageDimensions(buffer);

  const needsResize = width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT;

  // Determine if we can pass through the original format
  const isPassthroughFormat =
    format === "png" || format === "jpeg" || format === "jpg";

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

  const tempInput = join(
    tmpdir(),
    `resize-input-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tempInput, buffer);

  try {
    if (needsResize) {
      // Resize preserving aspect ratio
      // ImageMagick's -resize with geometry like "2000x2000>" preserves aspect ratio
      // and only shrinks (doesn't enlarge) - equivalent to 'inside' fit
      const tempOutput = join(
        tmpdir(),
        `resize-output-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );

      let outputBuffer: Buffer;
      let outputMediaType: string;

      if (format === "jpeg" || format === "jpg") {
        // Preserve JPEG format with good quality (Codex uses 85)
        execSync(
          `magick "${tempInput}" -resize ${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT}> -quality 85 "${tempOutput}.jpg"`,
          {
            stdio: "ignore",
          },
        );
        outputBuffer = readFileSync(`${tempOutput}.jpg`);
        outputMediaType = "image/jpeg";
        unlinkSync(`${tempOutput}.jpg`);
      } else {
        // Default to PNG for everything else
        execSync(
          `magick "${tempInput}" -resize ${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT}> "${tempOutput}.png"`,
          {
            stdio: "ignore",
          },
        );
        outputBuffer = readFileSync(`${tempOutput}.png`);
        outputMediaType = "image/png";
        unlinkSync(`${tempOutput}.png`);
      }

      const { width: resizedWidth, height: resizedHeight } =
        await getImageDimensions(outputBuffer);

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
    const tempOutput = join(
      tmpdir(),
      `convert-output-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    );
    execSync(`magick "${tempInput}" "${tempOutput}"`, {
      stdio: "ignore",
    });
    const outputBuffer = readFileSync(tempOutput);
    unlinkSync(tempOutput);

    // Check byte limit after format conversion
    const compressed = await compressToFitByteLimit(
      outputBuffer,
      width,
      height,
    );
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
  } finally {
    unlinkSync(tempInput);
  }
}
