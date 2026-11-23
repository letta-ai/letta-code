import { type FsSandboxPolicy, getOrderedSandboxPathRules } from "./policy.js";

export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

interface SeatbeltDefine {
  name: string;
  value: string;
}

export function buildSeatbeltProfile(policy: FsSandboxPolicy): {
  profile: string;
  defines: SeatbeltDefine[];
} {
  const defines: SeatbeltDefine[] = [];
  const lines: string[] = ["(version 1)", "(allow default)"];

  if (policy.restrictWrites) {
    lines.push('(deny file-write* (subpath "/"))');
    lines.push('(allow file-write* (subpath "/dev"))');
  }

  policy.baseWritableRoots.forEach((root, i) => {
    const name = `BASEWRITABLE_${i}`;
    defines.push({ name, value: root });
    lines.push(`(allow file-write* (subpath (param "${name}")))`);
  });

  for (const rule of getOrderedSandboxPathRules(policy)) {
    const prefix =
      rule.kind === "deny"
        ? "DENIED"
        : rule.kind === "readonly"
          ? "READONLY"
          : "WRITABLE";
    const name = `${prefix}_${rule.index}`;
    defines.push({ name, value: rule.root });

    if (rule.kind === "deny") {
      lines.push(`(deny file-read* file-write* (subpath (param "${name}")))`);
      lines.push(`(allow file-read-metadata (literal (param "${name}")))`);
    } else if (rule.kind === "readonly") {
      lines.push(`(deny file-write* (subpath (param "${name}")))`);
      lines.push(`(allow file-read* (subpath (param "${name}")))`);
    } else {
      lines.push(`(allow file-read* file-write* (subpath (param "${name}")))`);
    }
  }

  return { profile: `${lines.join("\n")}\n`, defines };
}

export function buildSeatbeltArgs(policy: FsSandboxPolicy): string[] {
  const { profile, defines } = buildSeatbeltProfile(policy);
  const args = ["-p", profile];
  for (const { name, value } of defines) {
    args.push(`-D${name}=${value}`);
  }
  return args;
}
