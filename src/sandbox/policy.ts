import { posix, win32 } from "node:path";

export interface FsSandboxPolicy {
  baseWritableRoots: string[];
  deniedRoots: string[];
  readonlyRoots: string[];
  writableRoots: string[];
  restrictWrites: boolean;
}

export type SandboxBackend = "seatbelt" | "bwrap";

export const SANDBOX_ENV_VAR = "LETTA_SANDBOX";

export interface BuildPolicyOptions {
  baseWritableRoots?: string[];
  deniedRoots?: string[];
  readonlyRoots?: string[];
  writableRoots?: string[];
  restrictWrites?: boolean;
}

export function buildFsSandboxPolicy(
  options: BuildPolicyOptions,
): FsSandboxPolicy {
  return {
    baseWritableRoots: normalizeRoots(options.baseWritableRoots ?? []),
    deniedRoots: normalizeRoots(options.deniedRoots ?? []),
    readonlyRoots: normalizeRoots(options.readonlyRoots ?? []),
    writableRoots: normalizeRoots(options.writableRoots ?? []),
    restrictWrites: options.restrictWrites ?? false,
  };
}

export type SandboxPathRuleKind = "deny" | "readonly" | "writable";

export interface SandboxPathRule {
  kind: SandboxPathRuleKind;
  root: string;
  index: number;
}

export function getOrderedSandboxPathRules(
  policy: FsSandboxPolicy,
): SandboxPathRule[] {
  const rules: SandboxPathRule[] = [];
  const append = (kind: SandboxPathRuleKind, roots: string[]) => {
    roots.forEach((root, index) => {
      rules.push({ kind, root, index });
    });
  };

  append("deny", policy.deniedRoots);
  append("readonly", policy.readonlyRoots);
  append("writable", policy.writableRoots);

  const samePathPriority: Record<SandboxPathRuleKind, number> = {
    readonly: 0,
    writable: 1,
    deny: 2,
  };
  const depth = (root: string) => root.split("/").filter(Boolean).length;

  return rules.sort((a, b) => {
    const depthDifference = depth(a.root) - depth(b.root);
    if (depthDifference !== 0) return depthDifference;
    const pathDifference = a.root.localeCompare(b.root);
    if (pathDifference !== 0) return pathDifference;
    return samePathPriority[a.kind] - samePathPriority[b.kind];
  });
}

export function normalizeSandboxPath(path: string): string {
  const trimmed = path.trim();
  const absolute =
    posix.isAbsolute(trimmed) || win32.isAbsolute(trimmed)
      ? trimmed
      : posix.resolve("/", trimmed);
  const forward = absolute.replace(/\\/g, "/");
  return forward.replace(/\/+$/, "") || "/";
}

function normalizeRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root || !root.trim()) continue;
    seen.add(normalizeSandboxPath(root));
  }
  return [...seen];
}
