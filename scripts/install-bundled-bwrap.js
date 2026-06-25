#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const CODEX_BWRAP_RELEASE_TAG = "rust-v0.142.1";
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR_ROOT = join(REPO_ROOT, "vendor", "bwrap");
const MANIFEST_PATH = join(VENDOR_ROOT, "manifest.json");
const TARGETS = [
  {
    key: "linux-x64",
    asset: "bwrap-x86_64-unknown-linux-musl.tar.gz",
    extractedName: "bwrap-x86_64-unknown-linux-musl",
    expectedSha256:
      "7df960565a0dece99240ea4b9d0e011307817f9f3b73176c7b71fda44fe84765",
  },
  {
    key: "linux-arm64",
    asset: "bwrap-aarch64-unknown-linux-musl.tar.gz",
    extractedName: "bwrap-aarch64-unknown-linux-musl",
    expectedSha256:
      "0f543a7356ab343b4827222f910461d4196778f328b28acd6c126ef18e9557ab",
  },
];

async function downloadFile(url, dest) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "pipe" });
  if (!result.error && result.status === 0) return;

  const stderr = result.stderr?.toString().trim();
  const stdout = result.stdout?.toString().trim();
  const detail =
    result.error?.message || stderr || stdout || `exit ${result.status}`;
  throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function installTarget(target) {
  const targetDir = join(VENDOR_ROOT, target.key);
  mkdirSync(targetDir, { recursive: true });

  const tempDir = await mkdtemp(join(tmpdir(), "letta-bwrap-"));
  try {
    const url = `https://github.com/openai/codex/releases/download/${CODEX_BWRAP_RELEASE_TAG}/${target.asset}`;
    const archivePath = join(tempDir, target.asset);
    await downloadFile(url, archivePath);

    run("tar", ["xzf", archivePath, "-C", tempDir]);

    const extractedPath = join(tempDir, target.extractedName);
    if (!existsSync(extractedPath)) {
      throw new Error(
        `${target.asset} did not contain expected ${target.extractedName}`,
      );
    }

    const actualSha256 = sha256File(extractedPath);
    if (actualSha256 !== target.expectedSha256) {
      throw new Error(
        `${target.asset} SHA-256 mismatch: expected ${target.expectedSha256}, got ${actualSha256}`,
      );
    }

    const dest = join(targetDir, "bwrap");
    rmSync(dest, { force: true });
    writeFileSync(dest, readFileSync(extractedPath));
    chmodSync(dest, 0o755);

    return {
      asset: target.asset,
      path: `vendor/bwrap/${target.key}/bwrap`,
      sha256: actualSha256,
      source: url,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  mkdirSync(VENDOR_ROOT, { recursive: true });

  const manifest = {
    source: `https://github.com/openai/codex/releases/tag/${CODEX_BWRAP_RELEASE_TAG}`,
    targets: {},
  };

  for (const target of TARGETS) {
    const installed = await installTarget(target);
    manifest.targets[target.key] = installed;
    console.log(
      `installed ${basename(installed.path)} for ${target.key} sha256:${installed.sha256}`,
    );
  }

  writeFileSync(
    `${MANIFEST_PATH}.tmp`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  rmSync(MANIFEST_PATH, { force: true });
  writeFileSync(MANIFEST_PATH, readFileSync(`${MANIFEST_PATH}.tmp`));
  rmSync(`${MANIFEST_PATH}.tmp`, { force: true });
  console.log(`wrote ${MANIFEST_PATH}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
