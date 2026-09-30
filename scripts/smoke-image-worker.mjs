// Exercise the published Node worker with a newer Sharp installation in an
// ancestor directory. Sharp's JS and native binding must come from the same
// installed package, rather than mixing bundled JS with a runtime binding.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "letta-image-worker-smoke-"));
try {
  const install = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--prefix",
      root,
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "sharp@0.35.3",
    ],
    { encoding: "utf8" },
  );
  assert.equal(install.status, 0, install.stderr || install.error?.message);

  const worker = join(root, "image-resize-worker.mjs");
  copyFileSync(
    process.argv[2] ?? new URL("../image-resize-worker.js", import.meta.url),
    worker,
  );
  const require = createRequire(worker);
  const sharp = require("sharp");
  assert.equal(sharp.versions.sharp, "0.35.3");
  const png = await sharp({
    create: {
      width: 2,
      height: 3,
      channels: 3,
      background: { r: 70, g: 100, b: 130 },
    },
  })
    .png()
    .toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();

  for (const [mediaType, image] of [
    ["image/png", png],
    ["image/jpeg", jpeg],
  ]) {
    const result = spawnSync(process.execPath, [worker, mediaType], {
      input: image,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const decoded = JSON.parse(result.stdout);
    assert.equal(decoded.mediaType, mediaType);
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 3);
    assert.deepEqual(Buffer.from(decoded.data, "base64"), image);
  }

  console.log("Published image worker decoded PNG and JPEG with Sharp 0.35.3");
} finally {
  rmSync(root, { recursive: true, force: true });
}
