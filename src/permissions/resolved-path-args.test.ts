import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPermission, checkPermissionWithHooks } from "./checker";
import { cliPermissions } from "./cli-permissions-instance";
import { isOwnMemoryWrite } from "./memory-write-allowance";
import { permissionMode } from "./mode";
import { resolvePermissionPath } from "./resolved-path-args";
import { sessionPermissions } from "./session";

let root: string;
let cwd: string;
let target: string;
const directoryLink = process.platform === "win32" ? "junction" : "dir";
const rules = { allow: [], deny: [], ask: [] };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "permission-paths-")));
  cwd = join(root, "workspace");
  target = join(root, "data");
  mkdirSync(cwd);
  mkdirSync(join(target, "nested"), { recursive: true });
  writeFileSync(join(target, "file.txt"), "fixture");
  symlinkSync(target, join(cwd, "linked"), directoryLink);
  permissionMode.setMode("standard");
});
afterEach(() => {
  permissionMode.reset();
  sessionPermissions.clear();
  cliPermissions.clear();
  rmSync(root, { recursive: true, force: true });
});

test("restrictive rules consider both names for file tools in both engines", () => {
  const previous = process.env.LETTA_PERMISSIONS_V2;
  try {
    for (const engine of ["0", "1"]) {
      process.env.LETTA_PERMISSIONS_V2 = engine;
      for (const tool of ["Read", "Write", "Edit", "Glob", "Grep", "ListDir"]) {
        for (const path of ["linked/file.txt", "linked/new/deep/file.txt"]) {
          const args = { path };
          for (const pattern of [
            `${tool}(${target}/**)`,
            `${tool}(linked/**)`,
          ]) {
            expect(
              checkPermission(tool, args, { ...rules, deny: [pattern] }, cwd)
                .decision,
            ).toBe("deny");
          }
          expect(
            checkPermission(
              tool,
              args,
              { ...rules, alwaysAsk: [`${tool}(${target}/**)`] },
              cwd,
            ).decision,
          ).toBe("alwaysAsk");
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.LETTA_PERMISSIONS_V2;
    else process.env.LETTA_PERMISSIONS_V2 = previous;
  }
});

test("aliases and CLI restrictions use resolved targets", () => {
  for (const tool of [
    "read_file",
    "ReadFile",
    "NotebookEdit",
    "MultiEdit",
    "grep_files",
    "LS",
    "list_dir",
  ]) {
    const canonical = ["NotebookEdit", "MultiEdit"].includes(tool)
      ? "Edit"
      : ["LS", "list_dir"].includes(tool)
        ? "ListDir"
        : tool === "grep_files"
          ? "Grep"
          : "Read";
    expect(
      checkPermission(
        tool,
        { file_path: "linked/file.txt" },
        { ...rules, deny: [`${canonical}(${target}/**)`] },
        cwd,
      ).decision,
    ).toBe("deny");
  }
  cliPermissions.setDisallowedTools(`Read(${target}/**)`);
  expect(
    checkPermission("Read", { path: "linked/file.txt" }, rules, cwd).decision,
  ).toBe("deny");
});

test("components resolve in order before parent traversal", () => {
  symlinkSync(join(target, "nested"), join(cwd, "child"), directoryLink);
  const raw = `${cwd}/child/../file.txt`;
  expect(resolvePermissionPath(raw)).toBe(join(target, "file.txt"));
  for (const path of [raw, "child/../file.txt"]) {
    expect(
      checkPermission(
        "Read",
        { path },
        { ...rules, deny: [`Read(${target}/**)`] },
        cwd,
      ).decision,
    ).toBe("deny");
  }
  expect(resolvePermissionPath(`${cwd}/child/../missing/deep.txt`)).toBe(
    join(target, "missing", "deep.txt"),
  );
});

test("relative rules still match with a symlinked working directory", () => {
  symlinkSync(cwd, join(root, "workspace-link"), directoryLink);
  mkdirSync(join(cwd, "docs"));
  symlinkSync(join(cwd, "docs"), join(cwd, "shortcut"), directoryLink);
  expect(
    checkPermission(
      "Read",
      { path: "shortcut/new.txt" },
      { ...rules, deny: ["Read(docs/**)"] },
      join(root, "workspace-link"),
    ).decision,
  ).toBe("deny");
});

test("permission hooks retain the restrictive decision", async () => {
  const args = { path: "linked/file.txt" };
  expect(
    (
      await checkPermissionWithHooks(
        "Read",
        args,
        { ...rules, deny: [`Read(${target}/**)`] },
        cwd,
      )
    ).decision,
  ).toBe("deny");
  expect(args).toEqual({ path: "linked/file.txt" });
});

test("symlinked memory roots allow internal writes and ask for external targets", () => {
  const previous = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = join(cwd, "linked");
  try {
    expect(
      isOwnMemoryWrite(
        "Write",
        { path: "linked/new.txt" },
        cwd,
        "agent-path-test",
      ),
    ).toBe(true);
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(target, "external"), directoryLink);
    expect(
      isOwnMemoryWrite(
        "Write",
        { path: "linked/external/new.txt" },
        cwd,
        "agent-path-test",
      ),
    ).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = previous;
  }
});

test.skipIf(process.platform === "win32")(
  "dangling links retain targets and cyclic links do not auto-allow",
  () => {
    symlinkSync(join(target, "missing.txt"), join(cwd, "dangling"));
    expect(resolvePermissionPath(join(cwd, "dangling"))).toBe(
      join(target, "missing.txt"),
    );
    expect(
      checkPermission(
        "Write",
        { path: "dangling" },
        { ...rules, deny: [`Write(${target}/**)`] },
        cwd,
      ).decision,
    ).toBe("deny");
    symlinkSync("loop", join(cwd, "loop"));
    expect(checkPermission("Read", { path: "loop" }, rules, cwd).decision).toBe(
      "deny",
    );
  },
);

test("links within the workspace retain normal allowances", () => {
  mkdirSync(join(cwd, "docs"));
  symlinkSync(join(cwd, "docs"), join(cwd, "shortcut"), directoryLink);
  expect(
    checkPermission("ViewImage", { path: "shortcut/new.png" }, rules, cwd)
      .decision,
  ).toBe("allow");
  expect(
    checkPermission("ViewImage", { path: "linked/new.png" }, rules, cwd)
      .decision,
  ).toBe("ask");
  expect(
    checkPermission(
      "Write",
      { path: "linked/new.txt" },
      { ...rules, allow: ["Write(linked/**)"] },
      cwd,
    ).decision,
  ).toBe("allow");
});
