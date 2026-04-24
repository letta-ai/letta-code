import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function convertHeicToJpegWithSips(
  buffer: Buffer,
): Promise<Buffer> {
  const workDir = await mkdtemp(join(tmpdir(), "letta-heic-sips-"));
  const inputPath = join(workDir, "input.heic");
  const outputPath = join(workDir, "output.jpg");

  try {
    await writeFile(inputPath, buffer);
    await execFileAsync("/usr/bin/sips", [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "90",
      inputPath,
      "--out",
      outputPath,
    ]);

    return Buffer.from(await readFile(outputPath));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
