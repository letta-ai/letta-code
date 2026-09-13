import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { RuntimeWorkspaceSandbox } from "@/runtime-context";
import {
  detectSandboxBackend,
  type SandboxAvailability,
} from "@/sandbox/availability";
import { buildFsSandboxPolicy, type FsSandboxPolicy } from "@/sandbox/policy";
import { canonicalToolName, isShellToolName } from "./canonical";
import { extractApplyPatchPaths, extractFilePath } from "./cross-agent-guard";
import { canonicalizeRoot } from "./sandbox-policy";

type ToolArgs = Record<string, unknown>;

export interface WorkspaceSandboxInput {
  root: string;
  isolationRoot: string;
}

export function resolveWorkspaceSandbox(
  input: WorkspaceSandboxInput,
  options: { availability?: SandboxAvailability } = {},
): RuntimeWorkspaceSandbox {
  if (!isAbsolute(input.root) || !isAbsolute(input.isolationRoot)) {
    throw new Error("workspace sandbox paths must be absolute");
  }
  const root = canonicalizeRoot(input.root);
  const isolationRoot = canonicalizeRoot(input.isolationRoot);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("workspace sandbox root must be an existing directory");
  }
  if (!statSync(isolationRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      "workspace sandbox isolation root must be an existing directory",
    );
  }
  if (root === isolationRoot || !root.startsWith(`${isolationRoot}/`)) {
    throw new Error("workspace sandbox root must be inside its isolation root");
  }
  const availability = options.availability ?? detectSandboxBackend();
  if (!availability.backend) {
    throw new Error(
      `workspace sandbox requires a kernel sandbox backend (${availability.reason})`,
    );
  }
  return { root, isolationRoot };
}

export function buildWorkspaceSandboxPolicy(
  sandbox: RuntimeWorkspaceSandbox,
): FsSandboxPolicy {
  return buildFsSandboxPolicy({
    deniedRoots: [sandbox.isolationRoot],
    writableRoots: [sandbox.root],
    restrictWrites: true,
  });
}

function targetPaths(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
): string[] {
  if (isShellToolName(toolName)) return [];
  const rawPaths: string[] = [];
  if (
    toolName === "ApplyPatch" ||
    toolName === "apply_patch" ||
    toolName === "memory_apply_patch"
  ) {
    if (typeof toolArgs.input === "string") {
      rawPaths.push(...extractApplyPatchPaths(toolArgs.input));
    }
  } else {
    const filePath = extractFilePath(toolArgs);
    if (filePath) rawPaths.push(filePath);
    if (
      ["Glob", "Grep", "ListDir"].includes(canonicalToolName(toolName)) &&
      typeof toolArgs.pattern === "string" &&
      isAbsolute(toolArgs.pattern)
    ) {
      rawPaths.push(toolArgs.pattern);
    }
  }
  return rawPaths.map((path) =>
    canonicalizeRoot(isAbsolute(path) ? path : resolve(workingDirectory, path)),
  );
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isRecursiveTool(toolName: string): boolean {
  return ["Glob", "Grep", "ListDir"].includes(canonicalToolName(toolName));
}

function isWriteTool(toolName: string): boolean {
  return (
    ["Write", "Edit"].includes(canonicalToolName(toolName)) ||
    toolName === "ApplyPatch" ||
    toolName === "apply_patch" ||
    toolName === "memory_apply_patch"
  );
}

export interface WorkspaceSandboxGuardResult {
  matchedRule: "workspace sandbox";
  reason: string;
}

export function evaluateWorkspaceSandboxGuard(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
  sandbox?: RuntimeWorkspaceSandbox,
): WorkspaceSandboxGuardResult | null {
  if (!sandbox || isShellToolName(toolName)) return null;
  const paths = targetPaths(toolName, toolArgs, workingDirectory);
  for (const path of paths) {
    const insideWorkspace = isWithin(path, sandbox.root);
    const entersIsolationTree =
      isWithin(path, sandbox.isolationRoot) ||
      (isRecursiveTool(toolName) && isWithin(sandbox.isolationRoot, path));
    if (
      (isWriteTool(toolName) && !insideWorkspace) ||
      (entersIsolationTree && !insideWorkspace)
    ) {
      return {
        matchedRule: "workspace sandbox",
        reason: `Permission denied by workspace sandbox: ${path} is outside ${sandbox.root}`,
      };
    }
  }
  return null;
}
