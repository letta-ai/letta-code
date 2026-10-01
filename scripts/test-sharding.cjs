// Assign files before launching Bun, including suites that need their own
// process. Sharding each Bun invocation separately would duplicate or omit
// isolated suites. Keep file order within each shard unchanged.
function shardTestFiles(files, shard) {
  if (shard === undefined) return files;
  if (!/^[1-9]\d*\/[1-9]\d*$/u.test(shard)) {
    throw new Error("Expected --shard INDEX/COUNT, with 1 <= INDEX <= COUNT");
  }
  const [index, count] = shard.split("/").map(Number);
  if (!Number.isSafeInteger(count) || index > count) {
    throw new Error("Expected --shard INDEX/COUNT, with 1 <= INDEX <= COUNT");
  }
  return files.filter((_, position) => position % count === index - 1);
}

module.exports = { shardTestFiles };
