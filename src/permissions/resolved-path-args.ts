import { lstatSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { canonicalToolName } from "./canonical";
import { expandPathArgs } from "./file-path-args";

/** Resolve components in filesystem order, including links before `..` and missing leaves. */
export function resolvePermissionPath(input: string): string | null {
  // A different platform's absolute path cannot be inspected on this host.
  if (process.platform !== "win32" && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(input)) {
    return input;
  }
  const root = parse(input).root;
  if (!root) return null;
  let current = root;
  const separators = process.platform === "win32" ? /[\\/]/ : /\//;
  const pending = input.slice(root.length).split(separators);
  let links = 0;
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = resolve(current, part);
    try {
      if (lstatSync(next).isSymbolicLink()) {
        if (++links > 40) return null;
        const target = readlinkSync(next);
        if (isAbsolute(target)) current = parse(target).root;
        pending.unshift(
          ...target
            .slice(isAbsolute(target) ? parse(target).root.length : 0)
            .split(separators),
        );
      } else {
        current = next;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      current = next;
    }
  }
  return current;
}

/** Supplemental targets for restrictive rules; never substitute these for tool input. */
export function resolvedPathArgs(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  preserveTraversal = true,
): Record<string, unknown> | null {
  if (["Glob", "Grep"].includes(canonicalToolName(toolName)) && !args.path) {
    args = { ...args, path: cwd };
  }
  const expanded = expandPathArgs(
    toolName,
    args,
    cwd,
    process.env,
    undefined,
    preserveTraversal,
  );
  if (expanded === args) return args;
  const result = { ...expanded };
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = expanded[key];
    if (typeof value !== "string" || !value) continue;
    const resolved = resolvePermissionPath(value);
    if (resolved === null) return null;
    result[key] = resolved;
  }
  return result;
}
