import { expect, test } from "bun:test";
import { join } from "node:path";
import { getReflectionArenaHfCacheRoot } from "./reflection-arena-hf-upload";

test("Reflection Arena HF upload state follows the product config root", () => {
  const env = {
    HOME: "/Users/alice",
    LETTA_CONFIG_DIR: "/Users/alice/.dream",
  } as NodeJS.ProcessEnv;

  expect(getReflectionArenaHfCacheRoot(env, "/fallback")).toBe(
    join(env.LETTA_CONFIG_DIR as string, "reflection-arena", "hf-upload"),
  );
});

test("Reflection Arena HF upload state keeps the default Letta root", () => {
  expect(getReflectionArenaHfCacheRoot({}, "/Users/alice")).toBe(
    join("/Users/alice", ".letta", "reflection-arena", "hf-upload"),
  );
});
