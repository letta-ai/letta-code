import { resizeImageIfNeeded } from "@/utils/image-resize.sharp";

async function readInput(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const inputMediaType = process.argv[2];
  if (!inputMediaType) {
    throw new Error("Image media type is required");
  }

  const buffer = await readInput();
  const result = await resizeImageIfNeeded(buffer, inputMediaType);
  process.stdout.write(JSON.stringify(result));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message);
  process.exitCode = 1;
}
