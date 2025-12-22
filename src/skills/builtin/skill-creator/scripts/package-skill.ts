#!/usr/bin/env npx ts-node
/**
 * Skill Packager - Creates a distributable .skill file of a skill folder
 *
 * Usage:
 *   npx ts-node package-skill.ts <path/to/skill-folder> [output-directory]
 *
 * Example:
 *   npx ts-node package-skill.ts .skills/my-skill
 *   npx ts-node package-skill.ts .skills/my-skill ./dist
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
// Simple zip implementation using Node.js built-in zlib
// For a proper zip file, we'll create the structure manually
import { deflateSync } from "node:zlib";
import { validateSkill } from "./validate-skill";

interface ZipEntry {
  path: string;
  data: Buffer;
  isDirectory: boolean;
}

function createZip(entries: ZipEntry[]): Buffer {
  // Use archiver-like approach with raw buffer manipulation
  // For simplicity, we'll use a basic ZIP format

  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBuffer = Buffer.from(entry.path, "utf8");
    const compressedData = entry.isDirectory
      ? Buffer.alloc(0)
      : deflateSync(entry.data);
    const uncompressedSize = entry.isDirectory ? 0 : entry.data.length;
    const compressedSize = compressedData.length;

    // CRC32 calculation
    const crc = entry.isDirectory ? 0 : crc32(entry.data);

    // Local file header
    const localHeader = Buffer.alloc(30 + pathBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed to extract
    localHeader.writeUInt16LE(0, 6); // General purpose bit flag
    localHeader.writeUInt16LE(entry.isDirectory ? 0 : 8, 8); // Compression method (8 = deflate)
    localHeader.writeUInt16LE(0, 10); // File last modification time
    localHeader.writeUInt16LE(0, 12); // File last modification date
    localHeader.writeUInt32LE(crc, 14); // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18); // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
    localHeader.writeUInt16LE(pathBuffer.length, 26); // File name length
    localHeader.writeUInt16LE(0, 28); // Extra field length
    pathBuffer.copy(localHeader, 30);

    localHeaders.push(localHeader);
    localHeaders.push(compressedData);

    // Central directory header
    const centralHeader = Buffer.alloc(46 + pathBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed to extract
    centralHeader.writeUInt16LE(0, 8); // General purpose bit flag
    centralHeader.writeUInt16LE(entry.isDirectory ? 0 : 8, 10); // Compression method
    centralHeader.writeUInt16LE(0, 12); // File last modification time
    centralHeader.writeUInt16LE(0, 14); // File last modification date
    centralHeader.writeUInt32LE(crc, 16); // CRC-32
    centralHeader.writeUInt32LE(compressedSize, 20); // Compressed size
    centralHeader.writeUInt32LE(uncompressedSize, 24); // Uncompressed size
    centralHeader.writeUInt16LE(pathBuffer.length, 28); // File name length
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // File comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE(entry.isDirectory ? 0x10 : 0, 38); // External file attributes
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header
    pathBuffer.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);

    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);

  // End of central directory record
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  endRecord.writeUInt16LE(0, 4); // Number of this disk
  endRecord.writeUInt16LE(0, 6); // Disk where central directory starts
  endRecord.writeUInt16LE(entries.length, 8); // Number of central directory records on this disk
  endRecord.writeUInt16LE(entries.length, 10); // Total number of central directory records
  endRecord.writeUInt32LE(centralDirSize, 12); // Size of central directory
  endRecord.writeUInt32LE(centralDirOffset, 16); // Offset of start of central directory
  endRecord.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, endRecord]);
}

// CRC32 implementation
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
    const relativePath = relative(baseDir, fullPath);

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

function packageSkill(skillPath: string, outputDir?: string): string | null {
  const resolvedPath = resolve(skillPath);

  // Validate skill folder exists
  if (!existsSync(resolvedPath)) {
    console.error(`Error: Skill folder not found: ${resolvedPath}`);
    return null;
  }

  if (!statSync(resolvedPath).isDirectory()) {
    console.error(`Error: Path is not a directory: ${resolvedPath}`);
    return null;
  }

  // Validate SKILL.md exists
  const skillMdPath = join(resolvedPath, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    console.error(`Error: SKILL.md not found in ${resolvedPath}`);
    return null;
  }

  // Run validation before packaging
  console.log("Validating skill...");
  const { valid, message } = validateSkill(resolvedPath);
  if (!valid) {
    console.error(`Validation failed: ${message}`);
    console.error("Please fix the validation errors before packaging.");
    return null;
  }
  console.log(`${message}\n`);

  // Determine output location
  const skillName = basename(resolvedPath);
  const outputPath = outputDir ? resolve(outputDir) : process.cwd();

  if (outputDir && !existsSync(outputPath)) {
    mkdirSync(outputPath, { recursive: true });
  }

  const skillFilename = join(outputPath, `${skillName}.skill`);

  // Create the .skill file (zip format)
  try {
    // Get all files, using parent directory as base so skill folder is included
    const parentDir = dirname(resolvedPath);
    const entries = getAllFiles(resolvedPath, parentDir);

    // Add the skill directory itself
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

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(
      "Usage: npx ts-node package-skill.ts <path/to/skill-folder> [output-directory]",
    );
    console.log("\nExample:");
    console.log("  npx ts-node package-skill.ts .skills/my-skill");
    console.log("  npx ts-node package-skill.ts .skills/my-skill ./dist");
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
