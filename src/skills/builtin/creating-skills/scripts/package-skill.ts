#!/usr/bin/env -S npx tsx

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { validateSkill } from "./validate-skill";

interface ZipEntry {
  path: string;
  data: Buffer;
  isDirectory: boolean;
}

function createZip(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBuffer = Buffer.from(entry.path, "utf8");
    const compressedData = entry.isDirectory
      ? Buffer.alloc(0)
      : deflateRawSync(entry.data);
    const uncompressedSize = entry.isDirectory ? 0 : entry.data.length;
    const compressedSize = compressedData.length;

    const crc = entry.isDirectory ? 0 : crc32(entry.data);

    const localHeader = Buffer.alloc(30 + pathBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(entry.isDirectory ? 0 : 8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(pathBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    pathBuffer.copy(localHeader, 30);

    localHeaders.push(localHeader);
    localHeaders.push(compressedData);

    const centralHeader = Buffer.alloc(46 + pathBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(entry.isDirectory ? 0 : 8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(pathBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    const unixMode = entry.isDirectory ? 0o40755 : 0o100644;
    const externalAttributes =
      ((unixMode << 16) | (entry.isDirectory ? 0x10 : 0)) >>> 0;
    centralHeader.writeUInt32LE(externalAttributes, 38);
    centralHeader.writeUInt32LE(offset, 42);
    pathBuffer.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);

    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirSize, 12);
  endRecord.writeUInt32LE(centralDirOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...centralHeaders, endRecord]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  const table = getCrc32Table();

  for (let i = 0; i < data.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: array access within bounds
    crc = (crc >>> 8) ^ (table[(crc ^ data[i]!) & 0xff] as number);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

let crc32Table: number[] | null = null;
function getCrc32Table(): number[] {
  if (crc32Table) return crc32Table;

  crc32Table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc32Table[i] = c;
  }
  return crc32Table;
}

function getAllFiles(dir: string, baseDir: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const items = readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = join(dir, item.name);
    const relativePath = normalizeZipEntryPath(relative(baseDir, fullPath));

    if (item.isDirectory()) {
      entries.push({
        path: `${relativePath}/`,
        data: Buffer.alloc(0),
        isDirectory: true,
      });
      entries.push(...getAllFiles(fullPath, baseDir));
    } else {
      entries.push({
        path: relativePath,
        data: readFileSync(fullPath),
        isDirectory: false,
      });
    }
  }

  return entries;
}

export function normalizeZipEntryPath(
  relativePath: string,
  separator = sep,
): string {
  return relativePath.split(separator).join("/");
}

function packageSkill(skillPath: string, outputDir?: string): string | null {
  const resolvedPath = resolve(skillPath);

  if (!existsSync(resolvedPath)) {
    console.error(`Error: Skill folder not found: ${resolvedPath}`);
    return null;
  }

  if (!statSync(resolvedPath).isDirectory()) {
    console.error(`Error: Path is not a directory: ${resolvedPath}`);
    return null;
  }

  const skillMdPath = join(resolvedPath, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    console.error(`Error: SKILL.md not found in ${resolvedPath}`);
    return null;
  }

  console.log("Validating skill...");
  const { valid, message } = validateSkill(resolvedPath);
  if (!valid) {
    console.error(`Validation failed: ${message}`);
    console.error("Please fix the validation errors before packaging.");
    return null;
  }
  console.log(`${message}\n`);

  const skillName = basename(resolvedPath);
  const outputPath = outputDir ? resolve(outputDir) : process.cwd();

  if (outputDir && !existsSync(outputPath)) {
    mkdirSync(outputPath, { recursive: true });
  }

  const skillFilename = join(outputPath, `${skillName}.skill`);

  try {
    const parentDir = dirname(resolvedPath);
    const entries = getAllFiles(resolvedPath, parentDir);

    entries.unshift({
      path: `${skillName}/`,
      data: Buffer.alloc(0),
      isDirectory: true,
    });

    const zipBuffer = createZip(entries);
    writeFileSync(skillFilename, zipBuffer);

    for (const entry of entries) {
      if (!entry.isDirectory) {
        console.log(`  Added: ${entry.path}`);
      }
    }

    console.log(`\nSuccessfully packaged skill to: ${skillFilename}`);
    return skillFilename;
  } catch (e) {
    console.error(
      `Error creating .skill file: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint
    ? resolve(entrypoint) === fileURLToPath(import.meta.url)
    : false;
}

if (isMainModule()) {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(
      "Usage: npx tsx package-skill.ts <path/to/skill-folder> [output-directory]",
    );
    console.log("\nExample:");
    console.log("  npx tsx package-skill.ts .skills/my-skill");
    console.log("  npx tsx package-skill.ts .skills/my-skill ./dist");
    process.exit(1);
  }

  const skillPath = args[0] as string;
  const outputDir = args[1];

  console.log(`Packaging skill: ${skillPath}`);
  if (outputDir) {
    console.log(`Output directory: ${outputDir}`);
  }
  console.log();

  const result = packageSkill(skillPath, outputDir);
  process.exit(result ? 0 : 1);
}

export { packageSkill };
