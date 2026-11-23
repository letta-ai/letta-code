import { join } from "node:path";

export function isCloudRepositoryNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 10 &&
    value.every(
      (name) =>
        typeof name === "string" &&
        /^[A-Za-z0-9._-]+$/.test(name) &&
        name === name.trim() &&
        name !== "." &&
        name !== "..",
    )
  );
}

export function cloudRepositoryRoots(names: readonly string[] = []): string[] {
  return [...new Set(names)].map((name) => join("/root/workspace", name));
}
