import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { resolveScopedMemoryDir } from "@/agent/memory-filesystem";
import {
  getMemoryOperationPath,
  withMemoryOperation,
} from "@/agent/memory-operation";
import {
  extractApplyPatchPaths,
  extractFilePath,
} from "@/permissions/cross-agent-guard";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { resolveCheckoutPath } from "@/utils/checkout-readiness";
import { expandFilePath } from "@/utils/file-path";
import { getShellEnv } from "./impl/shell-env";

function containsPath(root: string, target: string): boolean {
  const suffix = relative(root, resolveCheckoutPath(target));
  return (
    suffix === "" ||
    (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

/** Coordinate direct memory access with workers without stalling unrelated tools. */
export async function runMemoryTool<T>(
  name: string,
  args: Record<string, unknown>,
  run: (args: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const tool = name.replaceAll("_", "").toLowerCase();
  const shell = /^(bash|shell|shellcommand|runshellcommand|execcommand)$/.test(
    tool,
  );
  const file = /^(write|edit|multiedit|applypatch)$/.test(tool);
  const memoryTool = /^(memory|memoryapplypatch)$/.test(tool);
  if (!shell && !file && !memoryTool) return run(args);
  const env = shell ? getShellEnv() : process.env;
  const roots = [
    ...new Set(
      [env.MEMORY_DIR, env.LETTA_MEMORY_DIR, resolveScopedMemoryDir()]
        .filter((root): root is string => Boolean(root))
        .map(resolveCheckoutPath),
    ),
  ]
    .filter((root) => existsSync(join(root, ".git")))
    .sort();
  if (!roots.length) return run(args);
  const cwd = getCurrentWorkingDirectory();
  const paths: string[] = [];
  if (memoryTool) {
    const memoryDir = resolveScopedMemoryDir();
    if (memoryDir) paths.push(memoryDir);
  }
  let command = "";
  if (shell) {
    const shellCwd =
      typeof args.workdir === "string"
        ? expandFilePath(args.workdir, cwd)
        : cwd;
    paths.push(shellCwd);
    const input = args.command ?? args.cmd;
    command = Array.isArray(input)
      ? input.join(" ")
      : typeof input === "string"
        ? input
        : "";
    // Include literal/relative paths and env references, including commands that
    // compute paths in scripts. Run memory scripts from MEMORY_DIR so their
    // otherwise opaque file accesses participate in the same checkout lock.
    const expanded = command.replace(
      /\$(?:env:)?\{?([A-Za-z_][A-Za-z0-9_]*)\}?|%([A-Za-z_][A-Za-z0-9_]*)%/g,
      (match, posix: string, windows: string) => env[posix ?? windows] ?? match,
    );
    for (const token of expanded.match(/"[^"]*"|'[^']*'|[^\s;|&<>]+/g) ?? []) {
      paths.push(expandFilePath(token.replace(/^["']|["']$/g, ""), shellCwd));
    }
    command = expanded;
  } else {
    const path = extractFilePath(args);
    if (path) paths.push(expandFilePath(path, cwd));
    if (tool === "applypatch" && typeof args.input === "string") {
      paths.push(
        ...extractApplyPatchPaths(args.input).map((path) =>
          expandFilePath(path, cwd),
        ),
      );
    }
  }
  const targets = roots.filter(
    (root) =>
      paths.some((path) => containsPath(root, path)) ||
      (shell && command.includes(root)),
  );
  // A command may touch multiple checkouts. Deduplicate aliases and acquire
  // their locks in a stable order across processes.
  const repositories = new Map<string, string>();
  for (const root of targets)
    repositories.set(await getMemoryOperationPath(root), root);
  const ordered = [...repositories]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, root]) => root);
  const execute = (index: number): Promise<T> => {
    const root = ordered[index];
    return root
      ? withMemoryOperation(
          root,
          () => execute(index + 1),
          args.signal instanceof AbortSignal ? args.signal : undefined,
        )
      : run(args);
  };
  return execute(0);
}
