import { expect, test } from "bun:test";
import { createModChangeBatcher } from "@/mods/mod-change-batcher";

test("batches lifecycle notifications while preserving runtime updates", async () => {
  let changes = 0;
  const batcher = createModChangeBatcher(() => {
    changes += 1;
  });

  const dispose = await batcher.run(async () => {
    for (let index = 0; index < 20; index += 1) batcher.notify();
    await Promise.resolve();
    for (let index = 0; index < 20; index += 1) batcher.notify();
    return () => {
      for (let index = 0; index < 20; index += 1) batcher.notify();
    };
  });

  expect(changes).toBe(1);
  batcher.notify();
  expect(changes).toBe(2);
  batcher.runSync(dispose);
  expect(changes).toBe(3);
});

test("discards pending notifications when activation fails", async () => {
  let changes = 0;
  const batcher = createModChangeBatcher(() => {
    changes += 1;
  });

  await expect(
    batcher.run(async () => {
      batcher.notify();
      throw new Error("activation failed");
    }),
  ).rejects.toThrow("activation failed");

  expect(changes).toBe(0);
  batcher.notify();
  expect(changes).toBe(1);
});
