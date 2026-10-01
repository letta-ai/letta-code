const { describe, expect, test } = require("bun:test");
const { shardTestFiles } = require("./test-sharding.cjs");
const { tests: isolated } = require("./isolated-unit-tests.json");

describe("unit test sharding", () => {
  const files = [
    ...isolated.map(({ path }) => path),
    ...Array.from({ length: 103 }, (_, i) => `src/tools/file-${i}.test.ts`),
  ].sort();

  test.each([1, 4, 8, 200])("%i shards cover every file exactly once", (count) => {
    const shards = Array.from({ length: count }, (_, i) =>
      shardTestFiles(files, `${i + 1}/${count}`),
    );
    expect(shards.flat().sort()).toEqual(files);
    expect(new Set(shards.flat()).size).toBe(files.length);
    for (const shard of shards) {
      expect(shard).toEqual(files.filter((file) => shard.includes(file)));
    }
  });

  test("selection stays empty rather than expanding into all tests", () => {
    expect(shardTestFiles([], "1/8")).toEqual([]);
    expect(shardTestFiles([files[0]], "8/8")).toEqual([]);
  });

  test("local runs without a shard preserve the full selection", () => {
    expect(shardTestFiles(files)).toEqual(files);
  });

  test.each(["", "0/4", "1/0", "5/4", "-1/4", "1.5/4", "1/2/3", "1/Infinity"])(
    "rejects invalid shard %s rather than silently dropping coverage",
    (shard) => {
      expect(() => shardTestFiles(files, shard)).toThrow("Expected --shard");
    },
  );
});
