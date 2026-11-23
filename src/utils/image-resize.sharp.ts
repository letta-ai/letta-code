import sharp from "sharp";
import {
  assertImageHasDimensions,
  assertImageWithinBounds,
  buildResizeResult,
  canonicalizeOutputMediaType,
  fitsImageByteLimit,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_INPUT_PIXELS,
  MAX_IMAGE_WIDTH,
  type ResizeResult,
} from "./image-resize.shared";

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

async function compressToFitByteLimit(
  buffer: Buffer,
  currentWidth: number,
  currentHeight: number,
): Promise<ResizeResult | null> {
  if (fitsImageByteLimit(buffer)) {
    return null;
  }

  const qualities = [85, 70, 55, 40];
  for (const quality of qualities) {
    const compressed = await createSharpInstance(buffer)
      .jpeg({ quality })
      .toBuffer();
    if (fitsImageByteLimit(compressed)) {
      return buildVerifiedResizeResult(
        compressed,
        "image/jpeg",
        true,
        "compressed image output",
      );
    }
  }

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
    if (fitsImageByteLimit(reduced)) {
      return buildVerifiedResizeResult(
        reduced,
        "image/jpeg",
        true,
        "dimension-reduced image output",
      );
    }
  }

  throw new Error(
    `Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds the 5MB base64 image limit even after compression`,
  );
}

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

  const isPassthroughFormat = format === "png" || format === "jpeg";

  if (!needsResize && isPassthroughFormat) {
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
    const resized = image.resize(MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, {
      fit: "inside",
      withoutEnlargement: true,
    });

    let outputBuffer: Buffer;
    let outputMediaType: string;

    if (format === "jpeg") {
      outputBuffer = await resized.jpeg({ quality: 85 }).toBuffer();
      outputMediaType = "image/jpeg";
    } else {
      outputBuffer = await resized.png().toBuffer();
      outputMediaType = "image/png";
    }

    const { width: resizedWidth, height: resizedHeight } =
      await inspectImageBuffer(outputBuffer, "resized image output");

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

  const outputBuffer = await image.png().toBuffer();

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
