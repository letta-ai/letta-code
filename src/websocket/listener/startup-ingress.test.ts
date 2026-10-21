import { describe, expect, test } from "bun:test";
import { waitForStartupOrAbort } from "./startup-ingress";

describe("startup ingress cancellation", () => {
  test("returns immediately for an already-aborted connection", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForStartupOrAbort(new Promise(() => {}), controller.signal),
    ).resolves.toBeUndefined();
  });
});
