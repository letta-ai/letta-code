import { expect, test } from "bun:test";
import { queueSubagentUpdates } from "./subagents";

test("serializes completion and stop behind creation and survives a failed update", async () => {
  const created = Promise.withResolvers<string>();
  const completing = Promise.withResolvers<void>();
  const writingCompletion = Promise.withResolvers<void>();
  const writingStop = Promise.withResolvers<void>();
  const writes: string[] = [];
  const update = queueSubagentUpdates(created.promise, async (id, change) => {
    writes.push(`${id}:${change.status}`);
    if (change.status === "completed") {
      writingCompletion.resolve();
      await completing.promise;
    } else {
      writingStop.resolve();
    }
  });

  update({ status: "completed" });
  update({ status: "stopped" });
  await Promise.resolve();
  expect(writes).toHaveLength(0);

  created.resolve("subagent-record");
  await writingCompletion.promise;
  expect(writes).toEqual(["subagent-record:completed"]);

  completing.reject(new Error("transient write failure"));
  await writingStop.promise;
  expect(writes).toEqual([
    "subagent-record:completed",
    "subagent-record:stopped",
  ]);
});
