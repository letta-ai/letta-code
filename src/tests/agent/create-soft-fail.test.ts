import { afterEach, describe, expect, mock, test } from "bun:test";

describe("createAgent soft failures", () => {
  const originalConsoleError = console.error;

  afterEach(() => {
    console.error = originalConsoleError;
  });

  test("throws on an unknown model instead of exiting the process", async () => {
    console.error = mock(() => {});

    const { createAgent } = await import("../../agent/create");

    await expect(
      createAgent({
        model: "definitely-not-a-real-model",
      }),
    ).rejects.toThrow('Unknown model "definitely-not-a-real-model"');
  });
});
