import { describe, expect, test } from "bun:test";
import { ImageWorkerMissingError } from "./image-resize";

describe("ImageWorkerMissingError", () => {
  test("message names the expected worker path and reinstall guidance", () => {
    const workerPath = "/pkg/image-resize-worker.js";
    const error = new ImageWorkerMissingError(workerPath);

    expect(error.name).toBe("ImageWorkerMissingError");
    expect(error.workerPath).toBe(workerPath);
    expect(error.message).toContain(workerPath);
    expect(error.message).toContain("npm install -g @letta-ai/letta-code");
  });
});
