import { expect, test } from "bun:test";
import { join } from "node:path";
import { withNativeCliPath } from "./native-cli-env";

test("native CLI PATH fallback preserves defaults and is idempotent", () => {
  const env = { HOME: "/home/test", KEEP: "value" };
  const resolved = withNativeCliPath(env, "linux");
  expect(resolved).toEqual({
    ...env,
    PATH: `/usr/bin:/bin:${join(env.HOME, ".local", "bin")}`,
  });
  expect(withNativeCliPath(resolved, "linux")).toEqual(resolved);
  expect(env).not.toHaveProperty("PATH");
});

test("Windows PATH casing and search behavior are unchanged", () => {
  const env = { USERPROFILE: "C:\\Users\\test", Path: "C:\\tools;C:\\Windows" };
  expect(withNativeCliPath(env, "win32")).toEqual(env);
});
