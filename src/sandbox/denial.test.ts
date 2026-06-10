import { expect, test } from "bun:test";

import {
  describeSandboxDenial,
  isLikelySandboxDenial,
  isSandboxErrno,
} from "@/sandbox/denial";

test("isSandboxErrno matches filesystem-denial errno codes", () => {
  expect(isSandboxErrno("EPERM")).toBe(true);
  expect(isSandboxErrno("EACCES")).toBe(true);
  expect(isSandboxErrno("EROFS")).toBe(true);
  expect(isSandboxErrno("ENOENT")).toBe(false);
});

test("isSandboxErrno reads err.code off error objects", () => {
  expect(isSandboxErrno({ code: "EPERM" })).toBe(true);
  expect(isSandboxErrno({ code: "ENOENT" })).toBe(false);
  expect(isSandboxErrno(new Error("boom"))).toBe(false);
  expect(isSandboxErrno(null)).toBe(false);
});

test("isLikelySandboxDenial requires a nonzero exit and a denial keyword", () => {
  expect(isLikelySandboxDenial(1, "mkdir: Operation not permitted")).toBe(true);
  expect(isLikelySandboxDenial(1, "bash: foo: Permission denied")).toBe(true);
  expect(isLikelySandboxDenial(1, "Read-only file system")).toBe(true);
  // Clean exit is never a denial, even if output mentions permissions.
  expect(isLikelySandboxDenial(0, "permission denied")).toBe(false);
  expect(isLikelySandboxDenial(null, "permission denied")).toBe(false);
  // Unrelated failure.
  expect(isLikelySandboxDenial(1, "command not found")).toBe(false);
});

test("describeSandboxDenial lists the writable roots", () => {
  expect(describeSandboxDenial(["/a/memory", "/tmp"])).toContain(
    "/a/memory, /tmp",
  );
  expect(describeSandboxDenial([])).toContain("its own memory");
});
