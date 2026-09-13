import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import * as ts from "typescript";

export type RuntimePackageDirectoryResolver = (packageName: string) => string;

function getRuntimeDependencyPackages(source: string): string[] {
  const imports = ts.preProcessFile(source, true, true).importedFiles;
  return imports.some(
    (entry) =>
      entry.fileName === "react" || entry.fileName.startsWith("react/"),
  )
    ? ["react"]
    : [];
}

function normalizeRuntimeDependencyPath(value: string): string {
  const normalized = path.normalize(value).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function ensureRuntimeDependencySymlink(
  cacheDirectory: string,
  packageName: string,
  resolveRuntimePackageDirectory: RuntimePackageDirectoryResolver,
): void {
  const nodeModulesDirectory = path.join(cacheDirectory, "node_modules");
  const linkPath = path.join(nodeModulesDirectory, packageName);
  const packageDirectory = path.resolve(
    resolveRuntimePackageDirectory(packageName),
  );

  mkdirSync(nodeModulesDirectory, { recursive: true });
  try {
    const stats = lstatSync(linkPath);
    if (!stats.isSymbolicLink()) return;

    const existingTarget = readlinkSync(linkPath);
    const resolvedTarget = path.resolve(nodeModulesDirectory, existingTarget);
    if (
      normalizeRuntimeDependencyPath(resolvedTarget) ===
      normalizeRuntimeDependencyPath(packageDirectory)
    ) {
      return;
    }

    unlinkSync(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    symlinkSync(
      packageDirectory,
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function ensureRuntimeDependenciesForModCache(
  cacheDirectory: string,
  importableSource: string,
  resolveRuntimePackageDirectory: RuntimePackageDirectoryResolver,
): void {
  mkdirSync(cacheDirectory, { recursive: true });
  for (const packageName of getRuntimeDependencyPackages(importableSource)) {
    ensureRuntimeDependencySymlink(
      cacheDirectory,
      packageName,
      resolveRuntimePackageDirectory,
    );
  }
}
