import { expect, test } from "bun:test";
import { $ } from "bun";

test("--temp without -p should error", async () => {
  try {
    await $`bun run dev -- --temp`.quiet();
    throw new Error("Should have failed but didn't");
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error);
    expect(stderr).toContain("--temp");
    expect(stderr).toContain("headless");
  }
});

test("--temp with -p should work", async () => {
  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing LETTA_API_KEY in env");
  }

  const result =
    await $`bun run dev -- --temp -p "test" --output-format json --yolo`.text();
  const output = JSON.parse(result) as { agent_id: string; result: string };

  expect(output.agent_id).toBeDefined();
  expect(output.result).toBeDefined();
});
