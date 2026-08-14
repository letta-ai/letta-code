import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPermission } from "@/permissions/checker";
import { canonicalizeRoot } from "@/permissions/sandbox-policy";
import {
  buildWorkspaceSandboxPolicy,
  evaluateWorkspaceSandboxGuard,
  resolveWorkspaceSandbox,
} from "@/permissions/workspace-sandbox";
import { runWithRuntimeContext } from "@/runtime-context";
import type { SandboxAvailability } from "@/sandbox/availability";

const SEATBELT: SandboxAvailability = { backend: "seatbelt", reason: "test" };

function fixture(): {
  base: string;
  isolationRoot: string;
  root: string;
  peer: string;
} {
  const base = canonicalizeRoot(
    mkdtempSync(join(tmpdir(), "workspace-sandbox-")),
  );
  const isolationRoot = canonicalizeRoot(join(base, "runs"));
  const root = canonicalizeRoot(join(isolationRoot, "run-a"));
  const peer = canonicalizeRoot(join(isolationRoot, "run-b"));
  mkdirSync(root, { recursive: true });
  mkdirSync(peer, { recursive: true });
  return { base, isolationRoot, root, peer };
}

test("resolves a workspace inside its isolation root", () => {
  const dirs = fixture();
  try {
    expect(
      resolveWorkspaceSandbox(
        { root: dirs.root, isolationRoot: dirs.isolationRoot },
        { availability: SEATBELT },
      ),
    ).toEqual({ root: dirs.root, isolationRoot: dirs.isolationRoot });
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("fails closed without a kernel backend", () => {
  const dirs = fixture();
  try {
    expect(() =>
      resolveWorkspaceSandbox(
        { root: dirs.root, isolationRoot: dirs.isolationRoot },
        { availability: { backend: null, reason: "unavailable" } },
      ),
    ).toThrow("requires a kernel sandbox backend");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("builds a write-restricted policy that hides peer workspaces", () => {
  const dirs = fixture();
  try {
    expect(
      buildWorkspaceSandboxPolicy({
        root: dirs.root,
        isolationRoot: dirs.isolationRoot,
      }),
    ).toEqual({
      baseWritableRoots: [],
      deniedRoots: [dirs.isolationRoot],
      readonlyRoots: [],
      writableRoots: [dirs.root],
      restrictWrites: true,
    });
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("allows own writes and broad reads but denies peer access", () => {
  const dirs = fixture();
  const sandbox = { root: dirs.root, isolationRoot: dirs.isolationRoot };
  try {
    expect(
      evaluateWorkspaceSandboxGuard(
        "Write",
        { file_path: join(dirs.root, "memory.md") },
        dirs.root,
        sandbox,
      ),
    ).toBeNull();
    expect(
      evaluateWorkspaceSandboxGuard(
        "Read",
        { file_path: "/etc/hosts" },
        dirs.root,
        sandbox,
      ),
    ).toBeNull();
    expect(
      evaluateWorkspaceSandboxGuard(
        "Read",
        { file_path: join(dirs.peer, "memory.md") },
        dirs.root,
        sandbox,
      )?.matchedRule,
    ).toBe("workspace sandbox");
    expect(
      evaluateWorkspaceSandboxGuard(
        "Write",
        { file_path: join(dirs.base, "outside.md") },
        dirs.root,
        sandbox,
      )?.matchedRule,
    ).toBe("workspace sandbox");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("follows symlinks before allowing a write", () => {
  const dirs = fixture();
  const link = join(dirs.root, "peer-link");
  symlinkSync(dirs.peer, link);
  try {
    expect(
      evaluateWorkspaceSandboxGuard(
        "Write",
        { file_path: join(link, "memory.md") },
        dirs.root,
        { root: dirs.root, isolationRoot: dirs.isolationRoot },
      )?.matchedRule,
    ).toBe("workspace sandbox");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("the permission checker cannot override a workspace denial", () => {
  const dirs = fixture();
  try {
    const result = runWithRuntimeContext(
      {
        workspaceSandbox: {
          root: dirs.root,
          isolationRoot: dirs.isolationRoot,
        },
      },
      () =>
        checkPermission(
          "Write",
          { file_path: join(dirs.peer, "memory.md") },
          { allow: ["Write(**)"], deny: [], ask: [] },
          dirs.root,
        ),
    );
    expect(result).toMatchObject({
      decision: "deny",
      matchedRule: "workspace sandbox",
    });
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});
