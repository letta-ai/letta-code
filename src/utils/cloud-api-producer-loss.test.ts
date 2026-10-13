import { describe, expect, test } from "bun:test";
import { isCloudApiRunInterrupted } from "./cloud-api-shutdown";

describe("Cloud API run interruption", () => {
  test.each([false, true])(
    "recovers producer loss with replay retryable=%s",
    (retryable) => {
      expect(
        isCloudApiRunInterrupted({
          error_type: "internal_error",
          error_code: "RUN_STREAM_PRODUCER_LOST",
          run_id: "run-lost",
          retryable,
        }),
      ).toBe(true);
    },
  );

  test("preserves deployment recovery and rejects unrelated errors", () => {
    expect(
      isCloudApiRunInterrupted({
        error_type: "internal_error",
        error_code: "cloud_api_deployment_interrupted",
        status_code: 503,
        retryable: true,
      }),
    ).toBe(true);
    for (const error of [
      null,
      {},
      { error_type: "cancelled", error_code: "RUN_STREAM_PRODUCER_LOST" },
      { error_type: "internal_error", error_code: "OTHER" },
    ]) {
      expect(isCloudApiRunInterrupted(error)).toBe(false);
    }
  });
});
