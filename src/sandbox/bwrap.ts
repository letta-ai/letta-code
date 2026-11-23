import { type FsSandboxPolicy, getOrderedSandboxPathRules } from "./policy.js";

export const BWRAP_BIN = "bwrap";

export function buildBwrapArgs(policy: FsSandboxPolicy): string[] {
  const args: string[] = [];

  args.push(policy.restrictWrites ? "--ro-bind" : "--bind", "/", "/");

  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  for (const root of policy.baseWritableRoots) {
    args.push("--bind-try", root, root);
  }

  for (const rule of getOrderedSandboxPathRules(policy)) {
    switch (rule.kind) {
      case "deny":
        args.push("--tmpfs", rule.root);
        break;
      case "readonly":
        args.push("--ro-bind-try", rule.root, rule.root);
        break;
      case "writable":
        args.push("--bind-try", rule.root, rule.root);
        break;
    }
  }

  args.push("--die-with-parent");
  return args;
}
