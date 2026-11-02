import { expect, test } from "bun:test";
import {
  CloudReadinessError,
  isRetryableCloudReadinessError,
} from "./cloud-readiness-retry";

test.each([502, 503, 504])(
  "retries plain HTTP %s gateway failures",
  (status) => {
    expect(
      isRetryableCloudReadinessError(new CloudReadinessError(status)),
    ).toBe(true);
  },
);

test("retries a draining Cloud API", () => {
  expect(
    isRetryableCloudReadinessError(
      new CloudReadinessError(503, "cloud_api_shutting_down"),
    ),
  ).toBe(true);
});

test.each([400, 401, 403, 404, 409, 429, 500])(
  "does not retry HTTP %s",
  (status) => {
    expect(
      isRetryableCloudReadinessError(new CloudReadinessError(status)),
    ).toBe(false);
    expect(
      isRetryableCloudReadinessError(
        new CloudReadinessError(status, "cloud_api_shutting_down"),
      ),
    ).toBe(false);
  },
);

test("does not retry other structured service errors or arbitrary errors", () => {
  for (const status of [502, 503, 504]) {
    expect(
      isRetryableCloudReadinessError(
        new CloudReadinessError(status, "other_error"),
      ),
    ).toBe(false);
  }
  expect(isRetryableCloudReadinessError(new Error("HTTP 503"))).toBe(false);
  expect(isRetryableCloudReadinessError(new TypeError("fetch failed"))).toBe(
    false,
  );
});
