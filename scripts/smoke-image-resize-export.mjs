// Install the packed tarball into a throwaway consumer and require() the
// public image-resize entrypoint from CommonJS, as bundled Node services do.
// Proves the entry and the worker it spawns both ship, and that the entry has
// no top-level await (which CommonJS require() of ESM rejects).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(new URL("..", import.meta.url).pathname);
const consumer = mkdtempSync(join(tmpdir(), "letta-image-resize-export-"));
try {
  const [{ filename }] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", consumer], {
      cwd: repo,
      encoding: "utf8",
    }),
  );
  const pkg = join(consumer, "node_modules/@letta-ai/letta-code");
  mkdirSync(pkg, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(consumer, filename),
    "-C",
    pkg,
    "--strip-components=1",
  ]);
  // Reuse the repo's installed Sharp instead of a network install.
  for (const dep of ["sharp", "@img"]) {
    symlinkSync(
      join(repo, "node_modules", dep),
      join(consumer, "node_modules", dep),
    );
  }

  writeFileSync(
    join(consumer, "consumer.cjs"),
    `const { randomBytes } = require("node:crypto");
const sharp = require("sharp");
const { MAX_IMAGE_BYTES, resizeImageIfNeeded } = require("@letta-ai/letta-code/image-resize");
(async () => {
  const width = 1300, height = 1100;
  const png = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
  if (png.toString("base64").length <= MAX_IMAGE_BYTES) throw new Error("fixture must exceed the base64 limit");
  const result = await resizeImageIfNeeded(png, "image/png");
  process.stdout.write(JSON.stringify({ bytes: result.data.length, limit: MAX_IMAGE_BYTES }));
})().catch((error) => { console.error(error); process.exit(1); });
`,
  );
  const run = spawnSync(process.execPath, ["consumer.cjs"], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const { bytes, limit } = JSON.parse(run.stdout);
  assert.ok(bytes <= limit, `resized base64 ${bytes} exceeds ${limit}`);
  console.log(`image-resize export OK (${bytes} <= ${limit} base64 bytes)`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
