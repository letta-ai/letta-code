import { describe, expect, test } from "bun:test";
import {
  assertSupportedBunRuntime,
  MINIMUM_BUN_VERSION,
} from "./runtime-version";

describe("assertSupportedBunRuntime", () => {
  test("allows Node", () => {
    expect(() => assertSupportedBunRuntime(undefined)).not.toThrow();
  });

  test("rejects Bun before the isolated spawnSync event loop release", () => {
    expect(() => assertSupportedBunRuntime("1.3.1")).toThrow(
      `Bun ${MINIMUM_BUN_VERSION} or newer is required`,
    );
  });

  test("allows the first fixed Bun release", () => {
    expect(() => assertSupportedBunRuntime(MINIMUM_BUN_VERSION)).not.toThrow();
  });

  test("allows newer Bun releases", () => {
    expect(() => assertSupportedBunRuntime("1.3.14")).not.toThrow();
  });
});
