import { describe, expect, test } from "bun:test";
import {
  isCloudApiShutdownRejection,
  shouldEmitRetryNotice,
} from "./cloud-api-shutdown";

function shutdownError(overrides: Record<string, unknown> = {}) {
  return {
    status: 503,
    error: {
      error: "Service temporarily unavailable. Please retry your request.",
      errorCode: "cloud_api_shutting_down",
      admitted: false,
      retryable: true,
      ...overrides,
    },
  };
}

describe("Cloud API shutdown rejection", () => {
  test("keeps exact pre-admission shutdown retries out of the transcript", () => {
    const error = shutdownError();

    expect(isCloudApiShutdownRejection(error)).toBe(true);
    expect(shouldEmitRetryNotice(error)).toBe(false);
  });

  test.each([
    ["admitted work", { admitted: true }],
    ["non-retryable work", { retryable: false }],
    ["another service failure", { errorCode: "service_unavailable" }],
  ])("preserves the retry notice for %s", (_name, overrides) => {
    const error = shutdownError(overrides);

    expect(isCloudApiShutdownRejection(error)).toBe(false);
    expect(shouldEmitRetryNotice(error)).toBe(true);
  });
});
