import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { experimentManager } from "@/experiments/manager";
import { validateRequiredParams } from "./validation";

const ARTIFACTS_REFERENCE_ROOT = "external/artifacts/";
const ARTIFACTS_ALIAS_ROOT = "artifacts/";
const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;

type ArtifactEncoding = "utf8" | "base64";

interface ReadArtifactFileArgs {
  path: string;
  encoding?: ArtifactEncoding;
}

interface WriteArtifactFileArgs {
  path: string;
  content: string;
  encoding?: ArtifactEncoding;
}

interface ReadArtifactFileResult {
  path: string;
  content: string;
  encoding: ArtifactEncoding;
}

interface WriteArtifactFileResult {
  path: string;
  bytes: number;
  message: string;
}

function assertArtifactsExperimentEnabled(toolName: string): void {
  if (!experimentManager.isEnabled("artifacts")) {
    throw new Error(
      `${toolName}: artifacts experiment is disabled. Enable it with /experiments in Letta Code Desktop.`,
    );
  }
}

function getArtifactsRoot(): string {
  const override = process.env.LETTA_ARTIFACTS_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".letta", "artifacts");
}

function normalizeArtifactRelativePath(path: string): string {
  const withoutLeadingSlash = path.replace(/^\/+/, "").replace(/\\/g, "/");
  let normalized = withoutLeadingSlash;
  if (normalized.startsWith(ARTIFACTS_REFERENCE_ROOT)) {
    normalized = normalized.slice(ARTIFACTS_REFERENCE_ROOT.length);
  } else if (normalized.startsWith(ARTIFACTS_ALIAS_ROOT)) {
    normalized = normalized.slice(ARTIFACTS_ALIAS_ROOT.length);
  }

  if (!normalized) {
    throw new Error("artifact path must be a non-empty relative path");
  }
  if (isAbsolute(normalized)) {
    throw new Error("artifact path must be relative to ~/.letta/artifacts");
  }
  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error("artifact path cannot contain '..'");
  }
  return normalized;
}

function resolveArtifactPath(path: string): {
  absolutePath: string;
  relativePath: string;
} {
  const relativePath = normalizeArtifactRelativePath(path);
  const root = getArtifactsRoot();
  const absolutePath = resolve(root, relativePath);
  const relativeToRoot = relative(root, absolutePath);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error("artifact path must resolve inside ~/.letta/artifacts");
  }
  return { absolutePath, relativePath };
}

function getEncoding(value: ArtifactEncoding | undefined): ArtifactEncoding {
  return value === "base64" ? "base64" : "utf8";
}

export async function read_artifact_file(
  args: ReadArtifactFileArgs,
): Promise<ReadArtifactFileResult> {
  assertArtifactsExperimentEnabled("read_artifact_file");
  validateRequiredParams(args, ["path"], "read_artifact_file");
  const { absolutePath, relativePath } = resolveArtifactPath(args.path);
  const encoding = getEncoding(args.encoding);
  const stats = await stat(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`read_artifact_file: ${relativePath} is not a file`);
  }
  if (stats.size > MAX_READ_FILE_BYTES) {
    throw new Error(
      `read_artifact_file: file is too large to read (${stats.size} bytes)`,
    );
  }
  const buffer = await readFile(absolutePath);
  return {
    path: relativePath,
    content: buffer.toString(encoding),
    encoding,
  };
}

export async function write_artifact_file(
  args: WriteArtifactFileArgs,
): Promise<WriteArtifactFileResult> {
  assertArtifactsExperimentEnabled("write_artifact_file");
  validateRequiredParams(args, ["path", "content"], "write_artifact_file");
  const { absolutePath, relativePath } = resolveArtifactPath(args.path);
  const encoding = getEncoding(args.encoding);
  const buffer = Buffer.from(args.content, encoding);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);
  return {
    path: relativePath,
    bytes: buffer.byteLength,
    message: `Wrote artifact file ${relativePath} (${buffer.byteLength} bytes).`,
  };
}
