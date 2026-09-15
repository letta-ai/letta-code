import { describe, expect, test } from "bun:test";
import {
  isCloudApiDeploymentInterrupted,
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

describe("Cloud API deployment errors", () => {
  test("classifies only the exact accepted-work interruption code", () => {
    expect(
      isCloudApiDeploymentInterrupted({
        error_type: "internal_error",
        error_code: "cloud_api_deployment_interrupted",
        status_code: 503,
        retryable: true,
      }),
    ).toBe(true);
    expect(isCloudApiDeploymentInterrupted({ error_type: "cancelled" })).toBe(
      false,
    );
    expect(
      isCloudApiDeploymentInterrupted({
        error_type: "internal_error",
        error_code: "cloud_api_deployment_interrupted",
        status_code: 503,
        retryable: false,
      }),
    ).toBe(false);
    expect(
      isCloudApiDeploymentInterrupted({
        error_type: "internal_error",
        error_code: "cloud_api_deployment_interrupted",
        status_code: 500,
        retryable: true,
      }),
    ).toBe(false);
  });
});

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
