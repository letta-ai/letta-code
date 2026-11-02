import { expect, test } from "bun:test";
import { createCurrentDurableLockOwner } from "./durable-file-lock";

test("failed own-identity probes cool down from completion, then cache success", () => {
  let clock = 0;
  const budgets: number[] = [];
  const currentDurableLockOwner = createCurrentDurableLockOwner(
    (budget) => {
      budgets.push(budget);
      clock += budget; // Model a probe consuming its entire synchronous budget.
      return budgets.length < 3 ? null : "proven-start";
    },
    () => clock,
  );

  const first = currentDurableLockOwner(2_000);
  expect(first.processStart).toBeNull();
  expect(first.pid).toBe(process.pid);
  for (let i = 0; i < 20; i++) {
    const next = currentDurableLockOwner(500);
    expect(next.processStart).toBeNull();
    expect(next.token).not.toBe(first.token);
  }
  expect(budgets).toEqual([2_000]);
  expect(clock).toBe(2_000);

  clock += 4_999;
  expect(currentDurableLockOwner(250).processStart).toBeNull();
  expect(budgets).toEqual([2_000]);
  clock += 1;
  expect(currentDurableLockOwner(250).processStart).toBeNull();
  expect(budgets).toEqual([2_000, 250]);
  expect(currentDurableLockOwner(500).processStart).toBeNull();
  expect(budgets).toHaveLength(2);

  clock += 5_000;
  expect(currentDurableLockOwner(500).processStart).toBe("proven-start");
  clock += 60_000;
  expect(currentDurableLockOwner(2_000).processStart).toBe("proven-start");
  expect(budgets).toEqual([2_000, 250, 500]);
});
